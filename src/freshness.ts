/**
 * Frescor dos cubos SIH em relação ao espelho healthbr-data (elo 3 da cadeia).
 *
 * O Ministério da Saúde reedita arquivos RD de competências passadas. O
 * sync-check semanal do healthbr-data detecta a reedição (por tamanho do .dbc)
 * e republica a partição; o manifesto público do espelho passa a trazer outro
 * `source_hash_md5`/`source_size_bytes` para ela. O cubo deste servidor, gerado
 * antes, continua a somar o arquivo antigo — está ATRÁS do espelho. Este módulo
 * detecta isso, sem bloquear a inicialização e sem baixar 10 MB à toa:
 *
 *  1. Sonda: `GET` com `Range: bytes=0-511` no manifesto (R2 aceita Range; o
 *     `last_updated` está nos primeiros 256 bytes). Se for igual ao
 *     `distributor.manifest_last_updated` de todos os sidecars, o espelho não
 *     mudou desde o build e os cubos estão em dia — ~0,5 s, 512 bytes.
 *  2. Só se o manifesto mudou: baixa o arquivo inteiro (10,4 MB, ~1 s; o r2.dev
 *     não comprime) e compara partição a partição o que cada cubo usou
 *     (MD5 e tamanho do .dbc = reedição no MS; SHA-256 do Parquet = pipeline
 *     regenerou; partição sumiu) e se apareceu competência nova dentro da
 *     janela de um cubo incompleto (competência AAAA-MM afeta o cubo AAAA e,
 *     se MM <= 04, o cubo AAAA-1 — regra de docs/analise-001).
 *
 * Resultado: `current` | `stale` | `unknown` (rede/timeout) | `pending` |
 * `disabled` (SIH_FRESHNESS_CHECK=off — smoke e golden usam, para que o CI
 * nunca dependa do portal). Quem lê: `sihProvenance()` (marca `data_vintage`
 * e `notices` quando está atrás) e `get_available_years` (campo `freshness`).
 *
 * Fora do escopo daqui (itens (b) e (c) de `sih:cubos-frescor`): rebuild
 * automático e cache local de cubos. Isto só AVISA.
 */

import { loadSidecars, type SihSidecar } from "./provenance.js";

export type FreshnessStatus = "disabled" | "pending" | "current" | "stale" | "unknown";

export interface CubeFreshness {
  cube_year: number;
  /** Partições usadas cujo .dbc de origem mudou no espelho (MD5 ou tamanho): reedição do MS. */
  reedited: string[];
  /** Origem igual, Parquet diferente: o pipeline do espelho regenerou a partição. */
  reprocessed: string[];
  /** Partições usadas que não estão mais no manifesto. */
  removed: string[];
  /** Competências da janela do cubo publicadas no espelho depois do build (janela incompleta). */
  new_in_window: string[];
  /** true quando alguma das listas acima tem item. */
  behind: boolean;
}

export interface FreshnessState {
  status: FreshnessStatus;
  /** Instante (UTC) em que a última checagem terminou; null se nunca terminou. */
  checked_at: string | null;
  /** "range" = só a sonda de 512 bytes bastou; "full" = baixou o manifesto inteiro. */
  method: "range" | "full" | null;
  manifest_url: string | null;
  /** `distributor.manifest_last_updated` do(s) sidecar(s) — o manifesto com que os cubos foram gerados. */
  manifest_last_updated_local: string | null;
  /** `last_updated` lido do manifesto público agora. */
  manifest_last_updated_remote: string | null;
  cubes: CubeFreshness[];
  error: string | null;
}

/** Forma mínima do manifesto público do healthbr-data que a comparação usa. */
export interface MirrorManifest {
  last_updated?: string;
  partitions: Record<
    string,
    {
      source_hash_md5?: string;
      source_size_bytes?: number;
      output_files?: Array<{ sha256?: string }>;
    }
  >;
}

const PROBE_TIMEOUT_MS = 3_000;
const FULL_TIMEOUT_MS = 12_000;
/** Depois disto, a próxima chamada de ferramenta dispara nova checagem em segundo plano. */
const RECHECK_AFTER_MS = 6 * 60 * 60 * 1_000;

const DISABLED = (process.env.SIH_FRESHNESS_CHECK ?? "").trim().toLowerCase() === "off";

let state: FreshnessState = {
  status: DISABLED ? "disabled" : "pending",
  checked_at: null,
  method: null,
  manifest_url: null,
  manifest_last_updated_local: null,
  manifest_last_updated_remote: null,
  cubes: [],
  error: null,
};
let inFlight: Promise<FreshnessState> | null = null;

// =============================================================================
// COMPARAÇÃO (pura — testável offline com um trecho do manifesto)
// =============================================================================

function localManifestDate(sidecars: SihSidecar[]): string | null {
  const dates = [...new Set(sidecars.map((s) => s.distributor?.manifest_last_updated).filter(Boolean))].sort();
  return dates.at(-1) ?? null;
}

/** Compara cada cubo (sidecar) com o manifesto do espelho. */
export function compareWithManifest(sidecars: SihSidecar[], manifest: MirrorManifest): CubeFreshness[] {
  const parts = manifest.partitions ?? {};
  return sidecars.map((s) => {
    const used = new Set(s.partitions.map((p) => p.partition));
    const reedited: string[] = [];
    const reprocessed: string[] = [];
    const removed: string[] = [];
    for (const p of s.partitions) {
      const m = parts[p.partition];
      if (!m) {
        removed.push(p.partition);
        continue;
      }
      if (m.source_hash_md5 !== p.source_hash_md5 || m.source_size_bytes !== p.source_size_bytes) {
        reedited.push(p.partition);
        continue;
      }
      const sha = m.output_files?.[0]?.sha256;
      if (p.parquet_sha256 && sha && sha !== p.parquet_sha256) reprocessed.push(p.partition);
    }
    const expected = s.window?.competencias_expected ?? s.competencias;
    const new_in_window: string[] = [];
    for (const comp of expected) {
      for (const uf of s.ufs_arquivo) {
        const key = `${comp}-${uf}`;
        if (!used.has(key) && parts[key]) new_in_window.push(key);
      }
    }
    return {
      cube_year: s.cube_year,
      reedited,
      reprocessed,
      removed,
      new_in_window,
      behind: reedited.length + reprocessed.length + removed.length + new_in_window.length > 0,
    };
  });
}

/** Monta o estado final a partir do manifesto inteiro (usado pelo caminho "full" e pelo autoteste offline). */
export function evaluateManifest(sidecars: SihSidecar[], manifest: MirrorManifest, method: "range" | "full" = "full"): FreshnessState {
  const cubes = compareWithManifest(sidecars, manifest);
  return {
    status: cubes.some((c) => c.behind) ? "stale" : "current",
    checked_at: new Date().toISOString(),
    method,
    manifest_url: sidecars[0]?.distributor?.manifest_url ?? null,
    manifest_last_updated_local: localManifestDate(sidecars),
    manifest_last_updated_remote: manifest.last_updated ?? null,
    cubes,
    error: null,
  };
}

// =============================================================================
// CHECAGEM REMOTA
// =============================================================================

const LAST_UPDATED_RE = /"last_updated"\s*:\s*"([^"]+)"/;

async function fetchText(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} em ${url}`);
  return { status: res.status, text: await res.text() };
}

async function runCheck(): Promise<FreshnessState> {
  const sidecars = loadSidecars();
  const base: FreshnessState = {
    status: "unknown",
    checked_at: null,
    method: null,
    manifest_url: sidecars[0]?.distributor?.manifest_url ?? null,
    manifest_last_updated_local: localManifestDate(sidecars),
    manifest_last_updated_remote: null,
    cubes: [],
    error: null,
  };
  if (sidecars.length === 0 || !base.manifest_url) {
    return { ...base, checked_at: new Date().toISOString(), error: "sem sidecar de proveniência ao lado dos cubos" };
  }
  const url = base.manifest_url;
  try {
    // 1. Sonda: 512 bytes bastam para ler `last_updated`.
    const probe = await fetchText(url, PROBE_TIMEOUT_MS, { Range: "bytes=0-511" });
    let manifest: MirrorManifest | null = null;
    if (probe.status === 200) {
      // Servidor ignorou o Range e mandou tudo: aproveita.
      manifest = JSON.parse(probe.text) as MirrorManifest;
    } else {
      const remote = LAST_UPDATED_RE.exec(probe.text)?.[1] ?? null;
      const locals = new Set(sidecars.map((s) => s.distributor?.manifest_last_updated));
      if (remote && locals.size === 1 && locals.has(remote)) {
        return {
          ...base,
          status: "current",
          checked_at: new Date().toISOString(),
          method: "range",
          manifest_last_updated_remote: remote,
          cubes: sidecars.map((s) => ({
            cube_year: s.cube_year,
            reedited: [],
            reprocessed: [],
            removed: [],
            new_in_window: [],
            behind: false,
          })),
        };
      }
      // 2. O manifesto mudou (ou a sonda não deu para ler): baixa inteiro e compara.
      const full = await fetchText(url, FULL_TIMEOUT_MS);
      manifest = JSON.parse(full.text) as MirrorManifest;
    }
    return evaluateManifest(sidecars, manifest, "full");
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? `timeout (${e.message})` : e.message) : String(e);
    return { ...base, checked_at: new Date().toISOString(), error: msg };
  }
}

/**
 * Dispara a checagem em segundo plano e devolve na hora. Nunca rejeita; o
 * resultado fica em `getFreshness()`. Chamado uma vez no `main()` e, depois,
 * por `getFreshness()` quando a última checagem tem mais de 6 h.
 */
export function startFreshnessCheck(): Promise<FreshnessState> {
  if (DISABLED) return Promise.resolve(state);
  if (inFlight) return inFlight;
  inFlight = runCheck()
    .then((s) => {
      state = s;
      const resumo =
        s.status === "stale"
          ? `ATRÁS do espelho — ${s.cubes.filter((c) => c.behind).map((c) => c.cube_year).join(", ")}`
          : s.status === "unknown"
            ? `não verificado (${s.error})`
            : `em dia (manifesto ${s.manifest_last_updated_remote}, via ${s.method})`;
      console.error(`[frescor] cubos SIH: ${resumo}`);
      return s;
    })
    .catch((e) => {
      state = { ...state, status: "unknown", checked_at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
      return state;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Estado atual (sem esperar). Reagenda a checagem quando a última envelheceu. */
export function getFreshness(): FreshnessState {
  if (!DISABLED && !inFlight && state.checked_at && Date.now() - Date.parse(state.checked_at) > RECHECK_AFTER_MS) {
    void startFreshnessCheck();
  }
  if (state.manifest_url === null) {
    // Desligado ou ainda pendente: ao menos diz com que manifesto os cubos
    // foram gerados (vem do sidecar, determinístico — cabe no golden).
    const sidecars = loadSidecars();
    state = {
      ...state,
      manifest_url: sidecars[0]?.distributor?.manifest_url ?? null,
      manifest_last_updated_local: localManifestDate(sidecars),
    };
  }
  return state;
}

/** Só para testes: substitui o estado (não usa rede). */
export function setFreshnessForTests(s: FreshnessState): void {
  state = s;
}

/** Frescor de um cubo específico; null se não há veredito para ele. */
export function cubeFreshness(year: number): CubeFreshness | null {
  return state.cubes.find((c) => c.cube_year === year) ?? null;
}

/** Frase curta para o `data_vintage`/`notices` de um cubo atrás do espelho. */
export function describeBehind(c: CubeFreshness, remoteDate: string | null): string {
  const partes: string[] = [];
  const lista = (xs: string[]) => (xs.length <= 4 ? xs.join(", ") : `${xs.slice(0, 4).join(", ")} e mais ${xs.length - 4}`);
  const pl = (n: number, s: string, p: string) => `${n} ${n === 1 ? s : p}`;
  if (c.reedited.length) partes.push(`${pl(c.reedited.length, "partição reeditada", "partições reeditadas")} pelo MS (${lista(c.reedited)})`);
  if (c.reprocessed.length) partes.push(`${pl(c.reprocessed.length, "partição regenerada", "partições regeneradas")} no espelho (${lista(c.reprocessed)})`);
  if (c.removed.length) partes.push(`${pl(c.removed.length, "partição retirada", "partições retiradas")} do espelho (${lista(c.removed)})`);
  if (c.new_in_window.length) partes.push(`${pl(c.new_in_window.length, "competência nova", "competências novas")} na janela (${lista(c.new_in_window)})`);
  return `${partes.join("; ")}${remoteDate ? `; manifesto do espelho de ${remoteDate}` : ""}`;
}
