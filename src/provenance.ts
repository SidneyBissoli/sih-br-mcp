/**
 * Proveniência das respostas do sih-br-mcp (contrato @sbissoli/mcp-provenance v1).
 *
 * Cadeia dos cubos SIH: Ministério da Saúde / DATASUS (arquivos RD no FTP)
 *   -> healthbr-data (Parquet 1:1, manifesto com hash e data de download)
 *   -> scripts/build-aggregations.R (cubos por ano de competência)
 *   -> este servidor (filtra e soma).
 *
 * O elo que amarra a resposta à versão dos arquivos é o sidecar
 * `sih_provenance_<ano>.json` gravado ao lado de cada cubo pelo script R.
 * Dele saem `retrieved_at` (data de download do .dbc mais recente no
 * espelho — extração no upstream, não o instante da chamada) e
 * `data_vintage`. Por isso o bloco é determinístico e o golden pode
 * gravá-lo.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProvenanceContext,
  type CanonicalProvenance,
} from "@sbissoli/mcp-provenance";

import { configuredDataDirectory, getDataDirectory } from "./db/duckdb.js";
import { cubeFreshness, describeBehind, getFreshness } from "./freshness.js";
import csapGroups from "./data/csap-groups.json" with { type: "json" };
import cidChapters from "./data/cid-chapters.json" with { type: "json" };

export const SERVER_VERSION = "0.5.0";

export const provenance = createProvenanceContext({
  metaNamespace: "br.sbissoli.sih",
  locale: "pt-BR",
  defaultMode: "concise",
});

// =============================================================================
// SIDECAR DOS CUBOS
// =============================================================================

export interface SihSidecarPartition {
  partition: string;
  parquet_path: string;
  parquet_sha256: string | null;
  record_count: number;
  source_file: string;
  source_url: string;
  source_hash_md5: string;
  source_size_bytes: number;
  /** Só em sidecars do builder <= 2.1.0 (rodapé do Parquet); igual a processing_timestamp ao segundo. */
  download_date?: string;
  processing_timestamp: string;
  healthbr_pipeline_version: string;
  healthbr_git_commit: string;
}

export interface SihSidecar {
  manifest_version: string;
  dataset: string;
  cube_year: number;
  window?: {
    rule: string;
    months_after: number;
    competencias_expected: string[];
    complete: boolean;
    evidence: string;
  };
  competencias: string[];
  ufs_arquivo: string[];
  built_at: string;
  builder: {
    script: string;
    version: string;
    git_commit: string | null;
    r_version: string;
    arrow_version: string;
    /** Builder >= 2.2.0: o pacote healthbR que leu o espelho. */
    healthbr_version?: string;
  };
  source: { name: string; agency: string; database: string; endpoint: string };
  distributor: {
    name: string;
    url: string;
    bucket: string;
    manifest_url: string;
    manifest_last_updated: string;
    license: string;
  };
  retrieved_at: string;
  partitions: SihSidecarPartition[];
  totals: Record<string, number>;
  notes: string[];
}

const SIDECAR_RE = /^sih_provenance_(\d{4})\.json$/;

let sidecars: SihSidecar[] | null = null;

/** Lê os sidecars da pasta de cubos em uso (uma vez por processo). */
export function loadSidecars(): SihSidecar[] {
  if (sidecars) return sidecars;
  // Sem Parquet na pasta (checkout limpo: o workflow rebuild-cubes.yml decide
  // o que reconstruir lendo SÓ os sidecars versionados), o sidecar ainda vale:
  // é o registro de safra, e é dele que o frescor parte.
  let dir: string;
  try {
    dir = getDataDirectory();
  } catch {
    dir = configuredDataDirectory();
  }
  if (!existsSync(dir)) {
    sidecars = [];
    return sidecars;
  }
  sidecars = readdirSync(dir)
    .filter((f) => SIDECAR_RE.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SihSidecar);
  return sidecars;
}

/** Só para testes: força a releitura dos sidecars. */
export function resetSidecars(): void {
  sidecars = null;
}

// =============================================================================
// FONTES
// =============================================================================

const DATASUS_FTP_DIR =
  "ftp://ftp.datasus.gov.br/dissemin/publicos/SIHSUS/200801_/Dados/";

const SIH_SOURCE = {
  name: "Ministério da Saúde — DATASUS, SIH/SUS (AIH reduzida, RD)",
  agency: "Ministério da Saúde",
  database: "SIH/SUS",
  endpoint: DATASUS_FTP_DIR,
};

const SIH_LICENSE = {
  id: null,
  name: "Dados abertos do DATASUS (Ministério da Saúde); redistribuição em Parquet pelo healthbr-data sob CC-BY-4.0",
  url: null,
  terms_url: "https://datasus.saude.gov.br/transferencia-de-arquivos/",
  verified_at: "2026-09-05",
};

/** Data em que as tabelas de referência (CSAP, CID) entraram no repositório. */
const REFERENCE_SNAPSHOT_AT = "2026-01-21T00:00:00Z";

/** Data de geração de data/pop_uf.parquet por scripts/build-population.R. */
const POPULATION_BUILT_AT = "2026-01-23T00:00:00Z";

function safraOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Marca de frescor no vintage — o modo concise não mostra `notices`, então a
 * única chave do bloco que o leitor vê é esta. Só aparece quando o cubo está
 * ATRÁS do espelho (ver src/freshness.ts); em dia, pendente, desligado ou sem
 * rede não acrescenta nada, para o golden (que roda com a checagem desligada)
 * continuar byte-idêntico.
 */
function behindMark(year: number): string {
  const c = cubeFreshness(year);
  if (!c || !c.behind) return "";
  return ` [ATRÁS do espelho healthbr-data: ${describeBehind(c, getFreshness().manifest_last_updated_remote)}]`;
}

function vintageOf(s: SihSidecar): string {
  const first = s.competencias[0];
  const last = s.competencias[s.competencias.length - 1];
  const janela = s.window
    ? `internações de ${s.cube_year} em competências ${first} a ${last}${s.window.complete ? "" : " (janela INCOMPLETA)"}`
    : `competências ${first} a ${last}`;
  return `${s.cube_year}: ${janela}, UF de arquivo ${s.ufs_arquivo.join("/")}, safra healthbr-data ${safraOf(s.retrieved_at)}${behindMark(s.cube_year)}`;
}

/** Avisos de frescor (bloco canônico/detailed). Vazio quando não há o que dizer. */
function freshnessNotices(used: SihSidecar[]): string[] {
  const f = getFreshness();
  if (f.status === "stale") {
    return used
      .map((s) => cubeFreshness(s.cube_year))
      .filter((c): c is NonNullable<typeof c> => !!c && c.behind)
      .map(
        (c) =>
          `Cubo ${c.cube_year} está ATRÁS do espelho healthbr-data: ${describeBehind(c, f.manifest_last_updated_remote)}. ` +
          `Os números vêm dos arquivos da safra do sidecar; rebuild pendente.`,
      );
  }
  if (f.status === "unknown") {
    return [`Frescor dos cubos não verificado contra o espelho healthbr-data (${f.error ?? "sem resposta"}).`];
  }
  return [];
}

/**
 * Bloco dos cubos SIH. `years` restringe aos anos consultados; sem anos (ou
 * sem sidecar para eles) o bloco descreve tudo que o servidor tem carregado.
 */
export function sihProvenance(years?: number[]): CanonicalProvenance {
  const all = loadSidecars();
  const wanted = years && years.length > 0 ? all.filter((s) => years.includes(s.cube_year)) : all;
  const used = wanted.length > 0 ? wanted : all;

  if (used.length === 0) {
    return provenance.build({
      source: SIH_SOURCE,
      source_url: DATASUS_FTP_DIR,
      license: SIH_LICENSE,
      dataset: { id: "sih/rd", version: null, name: "SIH/SUS — AIH reduzida (RD)" },
      data_vintage: null,
      retrieved_at: new Date(),
      citation:
        "Ministério da Saúde. Sistema de Informações Hospitalares do SUS (SIH/SUS), AIH reduzida. Brasília: DATASUS. Agregado por sih-br-mcp v" +
        SERVER_VERSION +
        " (safra não determinável).",
      derived: true,
      derivation_note:
        "Cubos agregados por sih-br-mcp; sem sih_provenance_<ano>.json ao lado dos cubos, a safra dos arquivos de origem não é determinável.",
      notices: [
        "Sidecar de proveniência ausente: retrieved_at é o instante da chamada, não a extração no upstream.",
      ],
      served_from_cache: null,
    });
  }

  const retrievedAt = used.map((s) => s.retrieved_at).sort().at(-1)!;
  const manifestVersion = used.map((s) => s.distributor.manifest_last_updated).sort().at(-1)!;
  const builtAt = used.map((s) => s.built_at).sort().at(-1)!;
  const files = used.reduce((n, s) => n + s.partitions.length, 0);
  const first = used[0]!;

  return provenance.build({
    source: SIH_SOURCE,
    source_url: DATASUS_FTP_DIR,
    license: SIH_LICENSE,
    dataset: {
      id: "sih/rd",
      version: manifestVersion,
      name: "SIH/SUS — AIH reduzida (RD), microdados por competência e UF",
    },
    data_vintage: used.map(vintageOf).join("; "),
    retrieved_at: retrievedAt,
    citation:
      `Ministério da Saúde. Sistema de Informações Hospitalares do SUS (SIH/SUS), AIH reduzida. Brasília: DATASUS. ` +
      `Microdados redistribuídos em Parquet por healthbr-data (Bissoli, 2026; CC-BY-4.0), safra ${safraOf(retrievedAt)}; ` +
      `agregados por sih-br-mcp v${SERVER_VERSION}.`,
    derived: true,
    derivation_note:
      `Agregação em cubos por ano de internação (causas, séries mensais, ICSAP) a partir de ${files} arquivo(s) RD do FTP do DATASUS, ` +
      `lidos do espelho healthbr-data (${first.distributor.bucket}; manifesto de ${manifestVersion}); ` +
      `year/month pela data de internação (DT_INTER), lendo as competências do ano e os ${first.window?.months_after ?? 0} meses seguintes ` +
      `(cobertura esperada 99,7–99,9% do ano; dezembro 99,3–99,7%); cubos gerados em ${builtAt} por ${first.builder.script} v${first.builder.version}. ` +
      `Hash MD5 e data de download de cada .dbc de origem em sih_provenance_<ano>.json.`,
    notices: freshnessNotices(used),
    served_from_cache: null,
  });
}

/** Lista Brasileira de ICSAP (Portaria MS/SAS 221/2008), transcrita em src/data. */
export function csapProvenance(): CanonicalProvenance {
  return provenance.build({
    source: {
      name: "Ministério da Saúde — Portaria MS/SAS nº 221/2008 (Lista Brasileira de ICSAP)",
      agency: "Ministério da Saúde",
      database: "Saúde Legis",
      endpoint: null,
    },
    source_url: csapGroups.metadata.url,
    license: {
      id: null,
      name: "Ato normativo público (Portaria MS/SAS nº 221, de 17 de abril de 2008)",
      url: null,
      terms_url: null,
      verified_at: null,
    },
    dataset: {
      id: "portaria-sas-221-2008",
      version: null,
      name: csapGroups.metadata.description,
    },
    data_vintage: "Portaria MS/SAS nº 221/2008, 19 grupos (g01–g19), transcrição em src/data/csap-groups.json",
    retrieved_at: REFERENCE_SNAPSHOT_AT,
    citation:
      "BRASIL. Ministério da Saúde. Secretaria de Atenção à Saúde. Portaria nº 221, de 17 de abril de 2008. Lista Brasileira de Internações por Condições Sensíveis à Atenção Primária.",
    derived: false,
    served_from_cache: null,
  });
}

/** Capítulos da CID-10 (OMS), transcritos em src/data. */
export function cidProvenance(): CanonicalProvenance {
  return provenance.build({
    source: {
      name: "OMS — CID-10, capítulos (versão " + cidChapters.metadata.version + ")",
      agency: "Organização Mundial da Saúde",
      database: "CID-10",
      endpoint: null,
    },
    source_url: "https://icd.who.int/browse10/2019/en",
    license: {
      id: null,
      name: "Classificação pública da OMS; capítulos transcritos em src/data/cid-chapters.json",
      url: null,
      terms_url: null,
      verified_at: null,
    },
    dataset: { id: "cid-10-capitulos", version: cidChapters.metadata.version, name: "CID-10 — capítulos I a XXII" },
    data_vintage: "CID-10 versão " + cidChapters.metadata.version,
    retrieved_at: REFERENCE_SNAPSHOT_AT,
    citation:
      "Organização Mundial da Saúde. Classificação Estatística Internacional de Doenças e Problemas Relacionados à Saúde, 10ª revisão (CID-10), versão " +
      cidChapters.metadata.version +
      ".",
    derived: false,
    served_from_cache: null,
  });
}

/** Denominadores populacionais por UF (IBGE, SIDRA tabela 7358). */
export function populationProvenance(): CanonicalProvenance {
  return provenance.build({
    source: {
      name: "IBGE — SIDRA, tabela 7358 (projeção da população por sexo e idade, UF)",
      agency: "IBGE",
      database: "SIDRA",
      endpoint: "https://apisidra.ibge.gov.br/values/t/7358",
    },
    source_url: "https://sidra.ibge.gov.br/tabela/7358",
    license: {
      id: null,
      name: "Dados abertos do IBGE",
      url: null,
      terms_url: null,
      verified_at: null,
    },
    dataset: { id: "sidra-7358", version: null, name: "Projeção da população por UF, 2000–2024" },
    data_vintage: "Projeções 2000–2024 baixadas por scripts/build-population.R (pop_uf.parquet)",
    retrieved_at: POPULATION_BUILT_AT,
    citation:
      "IBGE. Projeção da população do Brasil e das Unidades da Federação por sexo e idade. SIDRA, tabela 7358.",
    derived: true,
    derivation_note:
      "Denominadores por UF usados no cálculo de taxas; somente soma de estratos, sem interpolação nem projeção própria (regras em CONTEXT.md).",
    served_from_cache: null,
  });
}

// =============================================================================
// ENVELOPE
// =============================================================================

/** Anos mencionados nos argumentos (year, years, year_start..year_end). */
export function yearsFromArgs(args: unknown): number[] {
  if (!args || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  const out = new Set<number>();
  const add = (v: unknown) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 1900) out.add(n);
  };
  if (Array.isArray(a.years)) a.years.forEach(add);
  add(a.year);
  const start = Number(a.year_start);
  const end = Number(a.year_end);
  if (Number.isInteger(start) && Number.isInteger(end) && end >= start && end - start < 200) {
    for (let y = start; y <= end; y++) add(y);
  }
  return [...out].sort((x, y) => x - y);
}

/** Bloco(s) de proveniência de cada ferramenta. */
export function provenanceFor(tool: string, args: unknown): CanonicalProvenance | CanonicalProvenance[] {
  switch (tool) {
    case "list_csap_groups":
    case "classify_as_csap":
      return csapProvenance();
    case "list_cid_chapters":
      return cidProvenance();
    case "get_icsap":
    case "get_icsap_indicators":
    case "rank_csap_groups":
    case "compare_icsap_trends":
      return [sihProvenance(yearsFromArgs(args)), csapProvenance()];
    case "get_hospitalization_rates":
      return [sihProvenance(yearsFromArgs(args)), populationProvenance()];
    default:
      return sihProvenance(yearsFromArgs(args));
  }
}

/**
 * Envelopa o resultado de uma ferramenta com o bloco de proveniência.
 * O JSON do texto é o próprio structuredContent (com `provenance` e
 * `attribution`), para clientes que só leem texto; não há rodapé em parte
 * separada porque os scripts de smoke/golden juntam as partes e fazem
 * JSON.parse do todo.
 */
export function withProvenance(result: unknown, p: CanonicalProvenance | CanonicalProvenance[]) {
  const data =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { result };
  const r = provenance.result(data, p);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r.structuredContent, null, 2) }],
    structuredContent: r.structuredContent,
    _meta: r._meta,
  };
}
