/**
 * Proveniência das respostas do sih-br-mcp (contrato @sbissoli/mcp-provenance v1).
 *
 * Cadeia dos cubos SIH: Ministério da Saúde / DATASUS (arquivos RD no FTP)
 *   -> healthbr-data (Parquet 1:1, manifesto com hash e data de download)
 *   -> healthbr-data scripts/pipeline/sih-cubos/build-aggregations.R (cubos
 *      por ano de internação; até 2026-09-08 o builder vivia neste repositório)
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
import csapGroupsCid9 from "./data/csap-groups-cid9.json" with { type: "json" };
import cidChapters from "./data/cid-chapters.json" with { type: "json" };

export const SERVER_VERSION = "0.10.0";

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
  /** Builder >= 2.4.0: colunas cruas que o SIH-RD daquele ano não tem (RACA_COR antes de 2008; MUNIC_RES antes de 1994). */
  columns_missing?: string[];
  /** Builder >= 2.5.0: internações que entraram com DT_INTER vazio (data = competência do arquivo; 1992-01..04 e 1993-01). */
  records_date_imputed?: number;
  /** Builder >= 2.5.0: internações do cubo por revisão da CID ("9" = CID-9 de 6 dígitos, até 1997; "10" = CID-10). */
  cid_revision?: Record<string, number>;
  /** Builder >= 2.5.0: lista ICSAP usada por revisão ("9": "cid9-derivada"; "10": "portaria-221-2008"). */
  icsap_list_revision?: Record<string, string>;
  /** Builder >= 2.5.0: true quando o cubo tem ICSAP pela lista CID-9 derivada (não oficial). */
  not_official_icsap?: boolean;
  /** Builder >= 2.5.0: comparabilidade por grupo da lista CID-9 com a CID-10 (alta/media/baixa), só com CID-9. */
  icsap_comparability?: Record<string, string>;
  /** Builder >= 2.5.0: base de `uf` — "residencia" (MUNIC_RES, 1998+) ou "arquivo" (estabelecimento, 1992–1997). */
  uf_basis?: "residencia" | "arquivo";
  /** Builder >= 2.5.0: false quando `municipality_code` é nulo em todas as linhas (1992–1997). */
  municipality_available?: boolean;
  /** Builder >= 2.5.0: moeda de `value` por competência da janela (Cr$ BRE, CR$ BRR, R$ BRL). */
  currency?: { from: string; to: string; code: string; symbol: string; name: string }[];
  /**
   * Builder >= 2.6.0: universo do % ICSAP como o csapAIH (procedimento
   * obstétrico, parto e longa permanência fora do numerador e do denominador);
   * `excluded` traz as internações fora do universo por motivo.
   */
  csap_universe?: {
    method: string;
    method_source?: { name: string; author: string; version: string; url: string; license: string; functions: string[] };
    rules: string[];
    tables: string;
    records_in_universe: number | null;
    excluded: Record<string, number>;
  };
  notes: string[];
}

const SIDECAR_RE = /^sih_provenance_(\d{4})\.json$/;

let sidecars: SihSidecar[] | null = null;

/** Lê os sidecars da pasta de cubos em uso (uma vez por processo). */
export function loadSidecars(): SihSidecar[] {
  if (sidecars) return sidecars;
  // Sem Parquet na pasta configurada (SIH_DATA_DIR só com sidecars — é assim
  // que o job `decide` do produtor, no healthbr-data, mede o frescor dos
  // cubos publicados), o sidecar ainda vale: é o registro de safra, e é dele
  // que o frescor parte. Por isso a pasta CONFIGURADA tem precedência sempre
  // que tiver sidecar; só sem nenhum (o caso normal desde a 0.11.0: data/
  // não versiona sidecar — o estado é o canal) é que vale a pasta em uso — o cache local, que ensureYears() enche com o
  // sidecar junto do Parquet. Desde a 0.7.0 getDataDirectory() não lança mais
  // erro quando data/ está sem cubo (devolve o cache, possivelmente vazio),
  // então cair no catch não servia mais de critério (run 34071934742).
  const listIn = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((f) => SIDECAR_RE.test(f)).sort() : [];
  let dir = configuredDataDirectory();
  let files = listIn(dir);
  if (files.length === 0) {
    try {
      dir = getDataDirectory();
      files = listIn(dir);
    } catch {
      files = [];
    }
  }
  sidecars = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SihSidecar);
  return sidecars;
}

/** Força a releitura dos sidecars (testes; e o cache local, que grava sidecar novo ao baixar um ano). */
export function resetSidecars(): void {
  sidecars = null;
}

// =============================================================================
// RAÇA/COR POR ANO
// =============================================================================

/**
 * Anos cujo cubo NÃO tem raça/cor: RACA_COR só entra no leiaute da AIH em
 * 2008, e o builder >= 2.4.0 grava `race` nulo nesses cubos e o registra em
 * `columns_missing` no sidecar (1998–2007). Ano sem sidecar conta como tendo.
 */
export function yearsWithoutRace(): number[] {
  return loadSidecars()
    .filter((s) => (s.columns_missing ?? []).includes("RACA_COR"))
    .map((s) => s.cube_year)
    .sort((a, b) => a - b);
}

/**
 * Nota para a resposta de uma ferramenta que filtra ou agrupa por raça quando
 * algum ano consultado não tem a coluna. Sem `years` (a consulta cobre tudo
 * que está carregado), valem os anos carregados.
 */
export function raceNotes(years: number[] | undefined, loadedYears: number[]): string[] {
  const missing = yearsWithoutRace();
  if (missing.length === 0) return [];
  const asked = years && years.length > 0 ? years : loadedYears;
  const hit = missing.filter((y) => asked.includes(y));
  if (hit.length === 0) return [];
  return [
    `Raça/cor não existe no SIH-RD de ${hit.join(", ")} (RACA_COR entrou no leiaute da AIH em 2008): nessas linhas \`race\` é nulo — o filtro \`race\` não as alcança e, no agrupamento por \`race\`, elas formam o grupo null.`,
  ];
}

// =============================================================================
// ERA ANTIGA 1992–1997 (builder >= 2.5.0; docs/analise-002 e analise-003)
// =============================================================================

function sortedYears(pred: (s: SihSidecar) => boolean): number[] {
  return loadSidecars()
    .filter(pred)
    .map((s) => s.cube_year)
    .sort((a, b) => a - b);
}

/** Anos cujo cubo tem internações em CID-9 (sidecar `cid_revision["9"] > 0`; 1992–1997). */
export function yearsCid9(): number[] {
  return sortedYears((s) => (s.cid_revision?.["9"] ?? 0) > 0);
}

/** Anos cujo `uf` é a UF do ARQUIVO (estabelecimento), não de residência (sidecar `uf_basis = "arquivo"`; 1992–1997). */
export function yearsUfArquivo(): number[] {
  return sortedYears((s) => s.uf_basis === "arquivo");
}

/** Anos cujo `value` está, em alguma competência, em moeda anterior ao real (Cr$ ou CR$; 1992–1994). */
export function yearsPreReal(): number[] {
  return sortedYears((s) => (s.currency ?? []).some((c) => c.code !== "BRL"));
}

/** Internações que entraram sem DT_INTER (data = competência), por ano (1992 e 1993). */
export function dateImputedByYear(): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of loadSidecars()) {
    if ((s.records_date_imputed ?? 0) > 0) out[s.cube_year] = s.records_date_imputed as number;
  }
  return out;
}

/** Anos da lista que a consulta alcança: os pedidos ou, sem pedido, os carregados. */
function hitYears(list: number[], years: number[] | undefined, loadedYears: number[]): number[] {
  const asked = years && years.length > 0 ? years : loadedYears;
  return list.filter((y) => asked.includes(y));
}

const fmtInt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export interface EraAspects {
  /** A ferramenta devolve ICSAP (grupo CSAP, is_csap, indicadores). */
  icsap?: boolean;
  /** A ferramenta devolve `value` (valor pago). */
  value?: boolean;
  /** A ferramenta filtra ou agrupa por município. */
  municipality?: boolean;
  /** A ferramenta devolve ou agrupa por mês. */
  month?: boolean;
}

/**
 * Notas para a resposta de uma ferramenta que alcança anos da era antiga
 * (1992–1997): `uf` do arquivo e diagnóstico em CID-9 sempre que algum ano da
 * era entra; ICSAP derivada, moeda da época, município nulo e mês imputado só
 * quando a ferramenta usa a dimensão (`aspects`). Sem `years`, valem os anos
 * carregados. Vazio para 1998+ — o golden (fixture 2023) não muda.
 */
export function eraNotes(years: number[] | undefined, loadedYears: number[], aspects: EraAspects = {}): string[] {
  const notes: string[] = [];
  const ufa = hitYears(yearsUfArquivo(), years, loadedYears);
  if (ufa.length > 0) {
    notes.push(
      `Em ${ufa.join(", ")} \`uf\` é a UF do ARQUIVO (estabelecimento), não de residência: MUNIC_RES não existe no SIH-RD de 1992–1993 e é vazio até nov/1994 (sidecar uf_basis = "arquivo"; docs/analise-002-sih-1992-1997.md). Séries por UF não são estritamente comparáveis com 1998+ (a diferença é a internação fora da UF de residência).`,
    );
    if (aspects.municipality) {
      notes.push(
        `\`municipality_code\` é nulo em ${ufa.join(", ")}: o filtro por município não alcança esses anos e, no agrupamento por município, eles formam o grupo null.`,
      );
    }
  }
  const c9 = hitYears(yearsCid9(), years, loadedYears);
  if (c9.length > 0) {
    notes.push(
      `Diagnóstico em CID-9 em ${c9.join(", ")} (cid_revision = 9): \`cid_group\` é a categoria CID-9 de 3 dígitos ("466", "E883", "V01"), não o código CID-10, e \`cid_chapter\` é o capítulo CID-10 equivalente (src/data/cid9-chapters.json). Em 1997 convivem linhas em CID-9 e em CID-10 (internações faturadas em 1998), separáveis por \`cid_revision\`.`,
    );
    if (aspects.icsap) {
      notes.push(
        `ICSAP de ${c9.join(", ")} pela lista CID-9 DERIVADA e NÃO OFICIAL (src/data/csap-groups-cid9.json; docs/analise-003-icsap-cid9.md), validada na fronteira 1997/98 (razão global 1,05): g03 (anemia) e g05 (ouvido, nariz e garganta) NÃO são comparáveis com 1998+. Em 1997, as internações faturadas em jan–fev/1998 (cid_revision = 10) têm ICSAP subestimado (adaptação à CID-10).`,
      );
    }
  }
  if (aspects.value) {
    const pr = hitYears(yearsPreReal(), years, loadedYears);
    if (pr.length > 0) {
      notes.push(
        `\`value\` em ${pr.join(", ")} é NOMINAL na moeda da competência de faturamento (Cr$ cruzeiro até 1993-06, CR$ cruzeiro real 1993-07..1994-06, R$ desde 1994-07; sidecar currency): não somar nem comparar entre moedas nem com anos posteriores.`,
      );
    }
  }
  if (aspects.month) {
    const di = dateImputedByYear();
    const hit = hitYears(Object.keys(di).map(Number), years, loadedYears);
    if (hit.length > 0) {
      notes.push(
        `Internações sem DT_INTER na fonte em ${hit.map((y) => `${y} (${fmtInt(di[y])})`).join(", ")} (competências 1992-01..04 e 1993-01) entraram com mês = competência de faturamento (sidecar records_date_imputed).`,
      );
    }
  }
  return notes;
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

/**
 * Lista ICSAP em CID-9 DERIVADA da Portaria 221/2008 para o SIH de 1992–1997
 * (src/data/csap-groups-cid9.json; docs/analise-003-icsap-cid9.md). Não é ato
 * normativo: é tabela deste projeto, validada na fronteira 1997/98.
 */
export function csapCid9Provenance(): CanonicalProvenance {
  const m = csapGroupsCid9.metadata;
  return provenance.build({
    source: {
      name: "sih-br-mcp — lista ICSAP em CID-9 derivada da Portaria MS/SAS nº 221/2008 (NÃO oficial)",
      agency: "sih-br-mcp (Sidney Bissoli)",
      database: "src/data/csap-groups-cid9.json",
      endpoint: null,
    },
    source_url: "https://github.com/SidneyBissoli/sih-br-mcp/blob/master/docs/analise-003-icsap-cid9.md",
    license: {
      id: "MIT",
      name: "Tabela derivada deste projeto (MIT); listas de origem citadas no JSON: Caminal 2004, AHRQ PQI v6.0 (2016), CIHI 2008, tabelas CID-9 do DATASUS",
      url: null,
      terms_url: null,
      verified_at: null,
    },
    dataset: {
      id: "icsap-cid9-derivada",
      version: m.generated_at,
      name: `Lista ICSAP em CID-9 derivada (1992–1997): ${m.total_groups} grupos, ${m.total_rubrics} rubricas, ${m.total_codes6} códigos de 6 dígitos`,
    },
    data_vintage: `derivada e validada na fronteira 1997/98 em ${m.generated_at}; razão global de participação 1,05; g03 e g05 com comparabilidade baixa`,
    retrieved_at: REFERENCE_SNAPSHOT_AT,
    citation:
      "BISSOLI, S. Lista ICSAP em CID-9 derivada da Portaria MS/SAS nº 221/2008 para o SIH/SUS de 1992–1997 (docs/analise-003-icsap-cid9.md). sih-br-mcp, 2026. Não oficial.",
    derived: true,
    derivation_note:
      "Correspondência MANUAL por rubrica CID-9 (OMS 1975) ↔ CID-10 para cada um dos 19 grupos da Portaria 221/2008, conferida nos rótulos do DATASUS e nas listas de origem em CID-9 (Caminal 2004, AHRQ PQI v6.0/2016, CIHI 2008; GEMs só em 514); " +
      "perímetro da Portaria manda (485/486, 482.4, 483, 558, 590.2, 430/431, 410 ficam fora). Validada empiricamente na fronteira 1997/98 (participação por grupo em CID-9 vs CID-10): razão global 1,05; g03 e g05 com comparabilidade baixa por mudança de prática de codificação. Não é ato normativo.",
    served_from_cache: null,
  });
}

/**
 * Método do % ICSAP: o pacote R csapAIH (Fúlvio B. Nedel) — mesma lista da
 * Portaria 221/2008, mas com o universo de cálculo que a literatura brasileira
 * usa (fora: procedimento obstétrico, parto O80–O84, longa permanência). O
 * builder >= 2.6.0 grava a marca `exclusion` nos cubos (src/data/csap-universe.json).
 */
export function csapAihProvenance(): CanonicalProvenance {
  return provenance.build({
    source: {
      name: "csapAIH — Classificar Condições Sensíveis à Atenção Primária (pacote R, Fúlvio B. Nedel)",
      agency: "Fúlvio Borges Nedel",
      database: "github.com/fulvionedel/csapAIH",
      endpoint: null,
    },
    source_url: "https://github.com/fulvionedel/csapAIH",
    license: {
      id: "GPL-3.0",
      name: "GPL (>= 3) — método reproduzido em tabela (src/data/csap-universe.json), não código copiado",
      url: null,
      terms_url: null,
      verified_at: null,
    },
    dataset: {
      id: "csapaih-universo",
      version: "0.0.4.8",
      name: "Universo do % ICSAP como csapAIH::csapAIH() (procobst.rm, parto.rm, longa.rm)",
    },
    data_vintage:
      "csapAIH 0.0.4.8 (2026-01-16): fora do numerador e do denominador as internações por procedimento obstétrico (10 códigos SIGTAP; tabela antiga do SIH até 2007 por PROCOBST.CNV do DATASUS), com diagnóstico de parto O80–O84 (CID-9: 650, 669.5–669.7) e as AIH de longa permanência (IDENT = 5)",
    retrieved_at: REFERENCE_SNAPSHOT_AT,
    citation:
      "NEDEL, F. B. csapAIH: Classificar Condições Sensíveis à Atenção Primária. Pacote R, versão 0.0.4.8, 2026. https://github.com/fulvionedel/csapAIH",
    derived: true,
    derivation_note:
      "Universo reproduzido em tabela versionada e conferido contra o próprio pacote em 2023/RR (48.480 AIH): mesmas 38.020 internações no universo, 18 dos 19 grupos idênticos; o g01 difere em 18 AIH porque a regex da listaBRMS do pacote inclui B55–B56 e omite B05–B06 e B77.x, contra a Portaria — este servidor segue a Portaria (= listaBRAlfradique do pacote).",
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
    dataset: { id: "sidra-7358", version: null, name: "Projeção da população por UF, sexo e idade simples (SIDRA 7358, revisão 2018)" },
    data_vintage: "Projeções por UF baixadas por scripts/build-population.R até o último ano de cubo FECHADO do SIH (pop_uf.parquet; intervalo em get_available_years.population_years)",
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
    case "compare_icsap_trends": {
      // 0.9.0: quando a consulta alcança ano em CID-9 (1992–1997), a lista
      // derivada entra como terceira fonte, marcada como derivada e não oficial
      const years = yearsFromArgs(args);
      const blocks = [sihProvenance(years), csapProvenance()];
      if (yearsCid9().some((y) => years.length === 0 || years.includes(y))) blocks.push(csapCid9Provenance());
      // 0.10.0: o método do percentual (universo csapAIH) é fonte da resposta
      blocks.push(csapAihProvenance());
      return blocks;
    }
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
