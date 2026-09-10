/**
 * Cache local dos cubos — item (c) de `sih:cubos-frescor` (2026-09-06).
 *
 * Os cubos anuais (`sih_{causas,series,icsap}_<ano>.parquet` + sidecar) são
 * publicados pela pipeline sih-cubos do healthbr-data (rebuild-sih-cubes.yml;
 * até 08/09/2026 o produtor era o rebuild-cubes.yml deste repositório) em
 * `sih/cubos/` do bucket, servido em https://data.sidneybissoli.com/sih/cubos/
 * com um `manifest.json` (tamanho e SHA-256 por arquivo e por tabela de
 * classificação; healthbr-data scripts/pipeline/sih-cubos/cubes-manifest.mjs). O pacote npm
 * NÃO embarca cubo nenhum (~60 MB por ano): quando a pasta de dados do
 * projeto não tem cubos, o servidor usa `~/.cache/sih-br-mcp/cubos/` e baixa
 * de lá só os anos que a chamada pede, verificando SHA-256 antes de aceitar.
 *
 * Variáveis de ambiente:
 *   SIH_CUBES_CACHE=off      desliga tudo (smoke e golden usam: o baseline não
 *                            pode depender de rede — ver docs/plan-003).
 *   SIH_CACHE_DIR=<pasta>    onde guardar (padrão ~/.cache/sih-br-mcp/cubos).
 *   SIH_CUBES_BASE_URL=<url> outro canal (espelho, teste local).
 *
 * O que NÃO faz: não apaga nada, não atualiza cubo já presente (quem decide
 * que um cubo está atrás é o frescor, `src/freshness.ts`; a reposição é
 * apagar o arquivo do cache e chamar de novo).
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const CUBES_BASE_URL = (process.env.SIH_CUBES_BASE_URL ?? "https://data.sidneybissoli.com/sih/cubos/").replace(/\/?$/, "/");
export const CUBES_CACHE_ENABLED = process.env.SIH_CUBES_CACHE !== "off";

export type CubeKind = "causas" | "series" | "icsap";
const CUBE_KINDS: CubeKind[] = ["causas", "series", "icsap"];

export interface CubesManifestFile {
  name: string;
  size_bytes: number;
  sha256: string;
}

export interface CubesManifestYear {
  built_at: string | null;
  builder_version: string | null;
  records_in_cube: number | null;
  window_complete: boolean | null;
  ufs: number | null;
  manifest_last_updated: string | null;
  files: Record<CubeKind | "provenance", CubesManifestFile>;
}

export type PopulationKind = "pop_uf" | "pop_uf_agregado" | "pop_municipios";
const POPULATION_KINDS: PopulationKind[] = ["pop_uf", "pop_uf_agregado", "pop_municipios"];

/**
 * >= 1.2.0 (2026-09-08, sih:populacao-no-canal): os denominadores populacionais
 * publicados ao lado dos cubos pelo build-sih-population.yml do healthbr-data
 * (build-population.R): pop_uf (IBGE, Projeção 2024, UF × sexo × idade simples,
 * 2000..último cubo FECHADO), pop_municipios (DATASUS POPBR/POPSVS 1991–2024),
 * pop_uf_agregado (soma por UF, 1991–1999) e o sidecar pop_provenance.json.
 */
export interface CubesManifestPopulation {
  built_at: string | null;
  builder_version: string | null;
  /** Último ano de pop_uf = último cubo FECHADO do SIH (regra do CONTEXT.md). */
  last_year: number | null;
  rule?: string | null;
  sources?: Array<{ file: string; name: string; agency?: string | null; url?: string | null; years?: string | null }>;
  files: Record<PopulationKind | "provenance", CubesManifestFile>;
}

/**
 * Bloco de PRÉ-AGREGADOS do manifesto. Os dois blocos têm a MESMA forma —
 * um resumo (um arquivo, todos os anos), estratos por ano e um sidecar — e o
 * MESMO contrato de frescor: `derived_from` traz o sha256 do cubo-fonte POR
 * ANO, e ano cujo cubo publicado não é o da derivação NÃO usa o pré-agregado.
 *
 * - `icsap_summary` (>= 1.3.0, 2026-09-09, sih:serie-pre-agregada / PLAN-005),
 *   derivado dos cubos sih_icsap_*: sih_icsap_resumo.parquet (universe × year ×
 *   uf × cid_revision × csap_group + n_total do denominador, ~276 KB) e
 *   sih_icsap_estratos_YYYY.parquet (o DISTINCT dos estratos gravado por ano).
 * - `causas_summary` (>= 1.4.0, 2026-09-10, sih:causas-pre-agregada /
 *   PLAN-006), derivado dos cubos sih_causas_* (1.253 MB nos 34 anos):
 *   sih_causas_resumo.parquet — GRÃO A, year × uf × cid_chapter ×
 *   cid_revision × is_csap × exclusion com n, days, value e deaths, 569 KB nos
 *   34 anos — e sih_causas_estratos_YYYY.parquet — GRÃO B, o grão A mais sex,
 *   age_group (faixa quinquenal de pop_uf_agregado) e race.
 */
export interface CubesManifestSummary {
  built_at: string | null;
  builder_version: string | null;
  derived_from: Record<string, string>;
  files: {
    resumo: CubesManifestFile;
    estratos: Record<string, CubesManifestFile>;
    provenance: CubesManifestFile;
  };
}

/** Nome histórico do bloco da ICSAP, mantido para quem já importava. */
export type CubesManifestIcsapSummary = CubesManifestSummary;

export interface CubesManifest {
  manifest_version: string;
  dataset: string;
  generated_at: string;
  base_url: string;
  /** >= 1.1.0 (2026-09-08): quem gerou — repositório e pipeline do produtor. */
  producer?: { repository?: string; pipeline?: string; workflow?: string | null; run_url?: string | null };
  /** >= 1.1.0: tabelas de classificação publicadas em tables/, com SHA-256 — src/data/ é cópia (scripts/tables-check.mjs). */
  tables?: Record<string, CubesManifestFile>;
  /** >= 1.2.0: denominadores populacionais; null/ausente em manifesto anterior à população (não é erro do canal). */
  population?: CubesManifestPopulation | null;
  /** >= 1.3.0: pré-agregados da ICSAP; null/ausente em manifesto anterior (não é erro do canal). */
  icsap_summary?: CubesManifestSummary | null;
  /** >= 1.4.0: pré-agregados do cubo de causas; null/ausente em manifesto anterior. */
  causas_summary?: CubesManifestSummary | null;
  years: Record<string, CubesManifestYear>;
}

export function cubesCacheDir(): string {
  return process.env.SIH_CACHE_DIR ? resolve(process.env.SIH_CACHE_DIR) : join(homedir(), ".cache", "sih-br-mcp", "cubos");
}

/**
 * Anos com os cubos dos TIPOS pedidos presentes numa pasta (0.14.1: o cache é
 * ciente do tipo — quem consulta séries não precisa dos cubos de causas).
 * Sem `kinds`, os três, como sempre.
 */
export function yearsPresent(dir: string, kinds: CubeKind[] = CUBE_KINDS): number[] {
  if (!existsSync(dir)) return [];
  // `[].every()` é true: sem esta guarda, kinds vazio diria que TODO ano está
  // presente e o cache nunca baixaria nada. Sidecar sozinho é ensureSidecars().
  if (kinds.length === 0) return [];
  const years = new Set<number>();
  for (let y = 1990; y <= 2100; y++) {
    if (kinds.every((k) => existsSync(join(dir, `sih_${k}_${y}.parquet`)))) years.add(y);
  }
  return [...years].sort((a, b) => a - b);
}

/** Os três arquivos de população presentes numa pasta (o sidecar é opcional). */
export function populationPresent(dir: string): boolean {
  return existsSync(dir) && POPULATION_KINDS.every((k) => existsSync(join(dir, `${k}.parquet`)));
}

// ---------------------------------------------------------------------------
// Manifesto

const MANIFEST_TTL_MS = 10 * 60 * 1000;
let manifestMemo: { at: number; manifest: CubesManifest | null; source: "remote" | "disk" | "none" } | null = null;

function parseManifest(text: string): CubesManifest | null {
  try {
    const m = JSON.parse(text) as CubesManifest;
    if (!m || typeof m !== "object" || typeof m.years !== "object") return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Manifesto do canal: remoto (timeout curto), senão a cópia em disco da última
 * vez, senão null. Memoizado por 10 min. Nunca lança.
 */
export async function loadCubesManifest(opts: { timeoutMs?: number } = {}): Promise<{ manifest: CubesManifest | null; source: "remote" | "disk" | "none" }> {
  if (manifestMemo && Date.now() - manifestMemo.at < MANIFEST_TTL_MS) return manifestMemo;
  const diskPath = join(cubesCacheDir(), "manifest.json");
  let manifest: CubesManifest | null = null;
  let source: "remote" | "disk" | "none" = "none";
  try {
    const res = await fetch(CUBES_BASE_URL + "manifest.json", { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    if (res.ok) {
      const text = await res.text();
      manifest = parseManifest(text);
      if (manifest) {
        source = "remote";
        try {
          mkdirSync(cubesCacheDir(), { recursive: true });
          writeFileSync(diskPath, text);
        } catch {
          /* cache em disco é conveniência */
        }
      }
    }
  } catch {
    /* rede indisponível: cai para o disco */
  }
  if (!manifest && existsSync(diskPath)) {
    manifest = parseManifest(readFileSync(diskPath, "utf8"));
    if (manifest) source = "disk";
  }
  manifestMemo = { at: Date.now(), manifest, source };
  return manifestMemo;
}

export function publishedYears(manifest: CubesManifest | null): number[] {
  if (!manifest) return [];
  return Object.keys(manifest.years).map(Number).filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
}

/** Só para testes: injeta um manifesto e zera a memoização. */
export function setCubesManifestForTests(manifest: CubesManifest | null): void {
  manifestMemo = manifest ? { at: Date.now(), manifest, source: "remote" } : null;
}

/**
 * O manifesto já carregado nesta execução (memoizado), sem ir à rede — para
 * quem é síncrono, como populationProvenance(): depois de ensurePopulation()
 * o memo está cheio; com o cache desligado (fixture, golden) fica null.
 */
export function cachedCubesManifest(): CubesManifest | null {
  return manifestMemo?.manifest ?? null;
}

// ---------------------------------------------------------------------------
// Download com verificação

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

async function downloadVerified(file: CubesManifestFile, dir: string, timeoutMs: number): Promise<void> {
  // ?v=<sha256>: os objetos do canal são reescritos NO LUGAR a cada rebuild e a
  // borda do domínio guarda cópia pelo Cache-Control do objeto — sem isto, um
  // consumidor recebia o cubo do build anterior (HIT, Age 15 h) enquanto o
  // manifesto já assinava o novo, e a verificação abaixo falhava (2026-09-08,
  // sih_series_2023: 36.047 bytes servidos vs 36.352 no manifesto). A query
  // entra na chave de cache: versão nova = URL nova = nunca a cópia velha.
  const url = `${CUBES_BASE_URL}${file.name}?v=${file.sha256.slice(0, 16)}`;
  const final = join(dir, file.name);
  const tmp = `${final}.part-${process.pid}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
  const size = statSync(tmp).size;
  if (size !== file.size_bytes) {
    unlinkSync(tmp);
    throw new Error(`${file.name}: ${size} bytes recebidos, manifesto diz ${file.size_bytes}`);
  }
  const digest = await sha256File(tmp);
  if (digest !== file.sha256) {
    unlinkSync(tmp);
    throw new Error(`${file.name}: SHA-256 não confere com o manifesto`);
  }
  renameSync(tmp, final);
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Um ano = os cubos dos TIPOS pedidos + sidecar, todos verificados (0.14.1:
 * ciente do tipo — a série anual de 34 anos precisa de ~1,3 MB de cubos de
 * séries, não dos 1,6 GB dos três tipos; medido em 09/09/2026, a pergunta do
 * usuário no chat levou 4 min só baixando cubo que a consulta não lê).
 * Idempotente e sem corrida; sem `kinds`, os três, como sempre.
 */
export function ensureYear(dir: string, year: number, manifest: CubesManifest, log: (msg: string) => void = () => {}, kinds: CubeKind[] = CUBE_KINDS): Promise<void> {
  const entry = manifest.years[String(year)];
  if (!entry) return Promise.reject(new Error(`ano ${year} não está no canal ${CUBES_BASE_URL}`));
  const key = `${year}|${[...kinds].sort().join(",")}`;
  const have = inFlight.get(key);
  if (have) return have;
  const p = (async () => {
    mkdirSync(dir, { recursive: true });
    const wanted: CubesManifestFile[] = [...kinds.map((k) => entry.files[k]), entry.files.provenance].filter(Boolean);
    // Arquivos do ano em SEQUÊNCIA (contrato do selftest: ano recusado não
    // deixa rastro novo); o paralelismo fica no LOTE de anos do ensureYears —
    // é lá que a latência por requisição dominava (68 arquivos ≈ 68 s).
    for (const f of wanted) {
      const path = join(dir, f.name);
      if (existsSync(path) && statSync(path).size === f.size_bytes) continue;
      const t0 = Date.now();
      log(`baixando ${f.name} (${(f.size_bytes / 1e6).toFixed(1)} MB) de ${CUBES_BASE_URL}`);
      await downloadVerified(f, dir, 10 * 60 * 1000);
      log(`  ${f.name} ok em ${((Date.now() - t0) / 1000).toFixed(1)} s (SHA-256 confere)`);
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Garante os anos pedidos na pasta; `null` = todos os anos publicados (chamada
 * sem ano explícito varre a série inteira). Devolve o que baixou e o que não
 * existe no canal. Falha de rede num ano lança — o handler decide a mensagem.
 */
export async function ensureYears(dir: string, years: number[] | null, log?: (msg: string) => void, kinds: CubeKind[] = CUBE_KINDS): Promise<{ downloaded: number[]; unavailable: number[] }> {
  const { manifest } = await loadCubesManifest();
  if (!manifest) throw new Error(`manifesto dos cubos indisponível (${CUBES_BASE_URL}manifest.json) e sem cópia local`);
  const present = new Set(yearsPresent(dir, kinds));
  const wanted = (years ?? publishedYears(manifest)).filter((y) => !present.has(y));
  const downloaded: number[] = [];
  const unavailable: number[] = [];
  const fila = wanted.filter((y) => {
    if (!manifest.years[String(y)]) {
      unavailable.push(y);
      return false;
    }
    return true;
  });
  // Anos em lotes de 4 (0.14.1): latência por requisição domina o custo dos
  // arquivos pequenos; a primeira falha aborta o lote e propaga (como antes).
  const LOTE = 4;
  for (let i = 0; i < fila.length; i += LOTE) {
    const lote = fila.slice(i, i + LOTE);
    await Promise.all(lote.map((y) => ensureYear(dir, y, manifest, log, kinds)));
    downloaded.push(...lote);
  }
  return { downloaded, unavailable };
}

/**
 * Garante SÓ os sidecars de proveniência dos anos pedidos (0.14.2).
 *
 * As notas de era — CID-9 derivada e não oficial em 1992–1997, `uf` do
 * ARQUIVO e não de residência, `value` nominal em moeda pré-real, datas
 * imputadas — saem do sidecar, não do cubo nem do manifesto. O caminho do
 * resumo pré-agregado (PLAN-005) responde a série inteira sem baixar cubo
 * algum, e com isso as ressalvas sumiam da resposta: o número certo sem o
 * aviso que o torna interpretável. 0,3 MB por ano; nunca lança (a ressalva é
 * importante, mas derrubar a consulta por causa dela seria pior).
 */
/**
 * Sidecars já conferidos por SHA-256 NESTE processo: caminho → sha do
 * manifesto que bateu. Existe por causa dos sidecars PRÉ-ASSADOS na imagem do
 * container: um arquivo que veio da imagem precisa ser conferido pelo hash (o
 * tamanho sozinho não distingue um sidecar reescrito por um rebuild que por
 * acaso manteve o mesmo número de bytes), mas conferir os 34 a cada chamada
 * seria pagar o hash de 10 MB toda vez. Confere uma vez por processo e por
 * arquivo; se o manifesto passar a assinar outro sha, o memo não bate e o
 * arquivo é rebaixado.
 */
const sidecarVerificado = new Map<string, string>();

export async function ensureSidecars(dir: string, years: number[] | null, log: (msg: string) => void = () => {}): Promise<{ downloaded: number[] }> {
  const downloaded: number[] = [];
  try {
    const { manifest } = await loadCubesManifest();
    if (!manifest) return { downloaded };
    const wanted = years ?? publishedYears(manifest);
    mkdirSync(dir, { recursive: true });
    for (const y of wanted) {
      const f = manifest.years[String(y)]?.files?.provenance;
      if (!f) continue;
      const path = join(dir, f.name);
      if (sidecarVerificado.get(path) === f.sha256) continue;
      if (existsSync(path) && statSync(path).size === f.size_bytes && (await sha256File(path)) === f.sha256) {
        sidecarVerificado.set(path, f.sha256);
        continue;
      }
      await downloadVerified(f, dir, 60 * 1000);
      sidecarVerificado.set(path, f.sha256);
      log(`  ${f.name} ok (SHA-256 confere)`);
      downloaded.push(y);
    }
  } catch (err) {
    log(`sidecars indisponíveis (${err instanceof Error ? err.message : String(err)}) — a resposta pode sair sem as notas de era`);
  }
  return { downloaded };
}

let populationInFlight: Promise<{ downloaded: string[]; available: boolean }> | null = null;

/**
 * Garante os denominadores populacionais (três Parquet + pop_provenance.json)
 * na pasta, baixados do canal e verificados como um ano de cubos. Idempotente
 * (arquivo presente com o tamanho do manifesto não baixa) e sem corrida.
 * `available = false` quando o manifesto do canal não tem o bloco `population`
 * (manifesto anterior a 1.2.0) — o handler responde "sem denominador", não
 * "erro do canal". Falha de rede lança — o handler decide a mensagem.
 */
export function ensurePopulation(dir: string, log: (msg: string) => void = () => {}): Promise<{ downloaded: string[]; available: boolean }> {
  if (populationInFlight) return populationInFlight;
  const p = (async () => {
    const { manifest } = await loadCubesManifest();
    if (!manifest) throw new Error(`manifesto dos cubos indisponível (${CUBES_BASE_URL}manifest.json) e sem cópia local`);
    const pop = manifest.population;
    if (!pop || !pop.files) return { downloaded: [], available: false };
    mkdirSync(dir, { recursive: true });
    const wanted: CubesManifestFile[] = [...POPULATION_KINDS.map((k) => pop.files[k]), pop.files.provenance].filter(Boolean);
    const downloaded: string[] = [];
    for (const f of wanted) {
      const path = join(dir, f.name);
      if (existsSync(path) && statSync(path).size === f.size_bytes) continue;
      const t0 = Date.now();
      log(`baixando ${f.name} (${(f.size_bytes / 1e6).toFixed(1)} MB) de ${CUBES_BASE_URL}`);
      await downloadVerified(f, dir, 10 * 60 * 1000);
      log(`  ${f.name} ok em ${((Date.now() - t0) / 1000).toFixed(1)} s (SHA-256 confere)`);
      downloaded.push(f.name);
    }
    return { downloaded, available: true };
  })().finally(() => {
    populationInFlight = null;
  });
  populationInFlight = p;
  return p;
}

// ---------------------------------------------------------------------------
// Pré-agregados: ICSAP (PLAN-005) e cubo de causas (PLAN-006). O estado abaixo
// é o que o roteamento em src/db/duckdb.ts consulta de forma SÍNCRONA:
// caminhos dos arquivos já baixados E frescos. Com o cache desligado (fixture,
// golden) fica vazio e toda consulta cai no caminho clássico — o baseline não
// muda. Os dois blocos têm a mesma forma e o mesmo contrato, então a máquina
// abaixo é UMA só, parametrizada pelo bloco e pelo cubo-fonte.

export interface SummaryState {
  /** Caminho do resumo baixado, ou null. */
  resumoPath: string | null;
  /** Anos cujo derived_from bate com o cubo publicado (o resumo VALE para eles). */
  freshYears: Set<number>;
  /** Estratos por ano, já baixados e frescos. */
  estratosPaths: Map<number, string>;
}

/** Nome histórico do estado da ICSAP, mantido para quem já importava. */
export type IcsapSummaryState = SummaryState;

const emptyState = (): SummaryState => ({ resumoPath: null, freshYears: new Set(), estratosPaths: new Map() });

const icsapState: SummaryState = emptyState();
const causasState: SummaryState = emptyState();

export function icsapSummaryState(): SummaryState {
  return icsapState;
}

export function causasSummaryState(): SummaryState {
  return causasState;
}

function setStateForTests(target: SummaryState, state: Partial<SummaryState> | null): void {
  target.resumoPath = state?.resumoPath ?? null;
  target.freshYears = state?.freshYears ?? new Set();
  target.estratosPaths = state?.estratosPaths ?? new Map();
}

/** Só para testes: injeta o estado dos pré-agregados (equivalência). */
export function setIcsapSummaryStateForTests(state: Partial<SummaryState> | null): void {
  setStateForTests(icsapState, state);
}

export function setCausasSummaryStateForTests(state: Partial<SummaryState> | null): void {
  setStateForTests(causasState, state);
}

/**
 * Qual bloco do manifesto e qual cubo-fonte cada pré-agregado usa. É a única
 * coisa que difere entre os dois: o contrato de frescor, o download e o
 * registro do estado são idênticos.
 */
interface SummaryKind {
  block: (m: CubesManifest) => CubesManifestSummary | null | undefined;
  cube: CubeKind;
  state: SummaryState;
  rotulo: string;
}

const ICSAP_SUMMARY: SummaryKind = { block: (m) => m.icsap_summary, cube: "icsap", state: icsapState, rotulo: "resumo ICSAP" };
const CAUSAS_SUMMARY: SummaryKind = { block: (m) => m.causas_summary, cube: "causas", state: causasState, rotulo: "resumo de causas" };

/** Anos frescos do bloco: derived_from[y] = sha256 do cubo-fonte publicado. */
function summaryFreshYears(manifest: CubesManifest, kind: SummaryKind): Set<number> {
  const block = kind.block(manifest);
  const fresh = new Set<number>();
  if (!block?.derived_from) return fresh;
  for (const [y, entry] of Object.entries(manifest.years)) {
    if (block.derived_from[y] && block.derived_from[y] === entry.files?.[kind.cube]?.sha256) fresh.add(Number(y));
  }
  return fresh;
}

const summaryInFlight = new Map<CubeKind, Promise<{ available: boolean }>>();

/**
 * Garante o RESUMO na pasta (um arquivo, todos os anos) e registra o estado
 * para o roteamento. Baixa de novo quando o sha do manifesto mudou (rebuild +
 * nova derivação). `available = false` quando o manifesto não tem o bloco
 * (anterior a 1.3.0 / 1.4.0) — não é erro. Nunca lança: resumo é otimização, e
 * falha de rede aqui só deixa a consulta no caminho clássico.
 */
function ensureSummary(kind: SummaryKind, dir: string, log: (msg: string) => void): Promise<{ available: boolean }> {
  const running = summaryInFlight.get(kind.cube);
  if (running) return running;
  const p = (async () => {
    try {
      const { manifest } = await loadCubesManifest();
      const block = manifest ? kind.block(manifest) : null;
      if (!manifest || !block?.files?.resumo) return { available: false };
      mkdirSync(dir, { recursive: true });
      const f = block.files.resumo;
      const path = join(dir, f.name);
      const fresh = existsSync(path) && statSync(path).size === f.size_bytes && (await sha256File(path)) === f.sha256;
      if (!fresh) {
        const t0 = Date.now();
        log(`baixando ${f.name} (${(f.size_bytes / 1e3).toFixed(0)} KB) de ${CUBES_BASE_URL}`);
        await downloadVerified(f, dir, 60 * 1000);
        log(`  ${f.name} ok em ${((Date.now() - t0) / 1000).toFixed(1)} s (SHA-256 confere)`);
      }
      kind.state.resumoPath = path;
      kind.state.freshYears = summaryFreshYears(manifest, kind);
      return { available: true };
    } catch (err) {
      log(`${kind.rotulo} indisponível (${err instanceof Error ? err.message : String(err)}) — consultas seguem pelo caminho clássico`);
      return { available: false };
    }
  })().finally(() => {
    summaryInFlight.delete(kind.cube);
  });
  summaryInFlight.set(kind.cube, p);
  return p;
}

/**
 * Garante os ESTRATOS dos anos pedidos (na ICSAP, o denominador dos filtros
 * finos; nas causas, o grão B com sexo, faixa etária e raça).
 * Baixa só anos FRESCOS (derived_from = cubo publicado); nunca lança.
 */
async function ensureEstratos(kind: SummaryKind, dir: string, years: number[] | null, log: (msg: string) => void): Promise<void> {
  try {
    const { manifest } = await loadCubesManifest();
    const block = manifest ? kind.block(manifest) : null;
    if (!manifest || !block?.files?.estratos) return;
    const fresh = summaryFreshYears(manifest, kind);
    const wanted = (years ?? publishedYears(manifest)).filter((y) => fresh.has(y));
    mkdirSync(dir, { recursive: true });
    for (const y of wanted) {
      const f = block.files.estratos[String(y)];
      if (!f) continue;
      const path = join(dir, f.name);
      if (!existsSync(path) || statSync(path).size !== f.size_bytes || (await sha256File(path)) !== f.sha256) {
        const t0 = Date.now();
        log(`baixando ${f.name} (${(f.size_bytes / 1e6).toFixed(1)} MB) de ${CUBES_BASE_URL}`);
        await downloadVerified(f, dir, 5 * 60 * 1000);
        log(`  ${f.name} ok em ${((Date.now() - t0) / 1000).toFixed(1)} s (SHA-256 confere)`);
      }
      kind.state.estratosPaths.set(y, path);
    }
  } catch (err) {
    log(`estratos do ${kind.rotulo} indisponíveis (${err instanceof Error ? err.message : String(err)}) — a consulta segue pelo cubo`);
  }
}

export function ensureIcsapSummary(dir: string, log: (msg: string) => void = () => {}): Promise<{ available: boolean }> {
  return ensureSummary(ICSAP_SUMMARY, dir, log);
}

export function ensureCausasSummary(dir: string, log: (msg: string) => void = () => {}): Promise<{ available: boolean }> {
  return ensureSummary(CAUSAS_SUMMARY, dir, log);
}

export function ensureEstratosYears(dir: string, years: number[] | null, log: (msg: string) => void = () => {}): Promise<void> {
  return ensureEstratos(ICSAP_SUMMARY, dir, years, log);
}

export function ensureCausasEstratosYears(dir: string, years: number[] | null, log: (msg: string) => void = () => {}): Promise<void> {
  return ensureEstratos(CAUSAS_SUMMARY, dir, years, log);
}

/** Anos que uma chamada de ferramenta pede, lidos dos argumentos; null = não diz. */
export function yearsFromArgs(args: unknown): number[] | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const out = new Set<number>();
  const push = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === "number" && Number.isFinite(v)) out.add(v);
    else if (typeof v === "string" && /^\d{4}$/.test(v)) out.add(Number(v));
  };
  push(a.year);
  push(a.years);
  // Dois pares de nomes no schema das ferramentas: start_year/end_year
  // (compare_icsap_trends) e year_start/year_end (get_hospitalization_trends).
  // Sem o segundo par (até a 0.14.0), o trends caía no "sem ano" e baixava a
  // SÉRIE INTEIRA do canal — parte dos 4 min da pergunta do chat em 09/09.
  for (const [ini, fim] of [["start_year", "end_year"], ["year_start", "year_end"]] as const) {
    const a0 = a[ini];
    const a1 = a[fim];
    if (typeof a0 === "number" && typeof a1 === "number" && a1 >= a0) {
      for (let y = a0; y <= a1; y++) out.add(y);
    } else {
      push(a0);
      push(a1);
    }
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}
