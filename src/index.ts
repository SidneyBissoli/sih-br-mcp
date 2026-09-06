#!/usr/bin/env node

/**
 * SIH-BR-MCP: MCP Server para análise de dados do SIH-SUS
 * Foco em Internações por Condições Sensíveis à Atenção Primária (ICSAP)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getAvailableYears,
  getPopulationYearRange,
  closeDatabase,
  queryCausas,
  queryIcsap,
  querySeries,
  rankCsapGroups,
  calculateIcsapIndicators,
  hasPopulationData,
  getPopulation,
  getPopulationByUf,
  CausasFilters,
  IcsapFilters,
} from "./db/duckdb.js";

// Importa dados de referência
import csapGroups from "./data/csap-groups.json" with { type: "json" };
import cidChapters from "./data/cid-chapters.json" with { type: "json" };
import brazilRegions from "./data/brazil-regions.json" with { type: "json" };
import { SERVER_VERSION, provenanceFor, withProvenance } from "./provenance.js";
import { getFreshness, startFreshnessCheck } from "./freshness.js";

// =============================================================================
// DEFINIÇÃO DAS FERRAMENTAS
// =============================================================================

const tools: Tool[] = [
  // --- Metadados ---
  {
    name: "list_csap_groups",
    description:
      "Lista os 19 grupos de Condições Sensíveis à Atenção Primária (CSAP) " +
      "conforme Portaria MS/SAS 221/2008. Retorna código, nome e códigos CID-10 de cada grupo.",
    inputSchema: {
      type: "object",
      properties: {
        group_code: {
          type: "string",
          description: "Código do grupo específico (ex: 'g01'). Se omitido, retorna todos.",
        },
        include_cid_codes: {
          type: "boolean",
          description: "Se true, inclui lista de códigos CID-10 (default: false)",
        },
      },
    },
  },
  {
    name: "list_cid_chapters",
    description:
      "Lista os 22 capítulos da CID-10 com seus códigos e faixas de diagnóstico.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_available_years",
    description:
      "Retorna os anos disponíveis nos dados do SIH-SUS carregados e o frescor dos cubos em relação ao " +
      "espelho healthbr-data (`freshness.status`: current, stale, unknown, pending ou disabled; " +
      "quando stale, lista por ano as partições reeditadas pelo MS, regeneradas, retiradas ou novas na janela).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // --- Internações Gerais ---
  {
    name: "get_hospitalizations",
    description:
      "Consulta dados de internações hospitalares do SUS com filtros flexíveis. " +
      "Permite agregar por múltiplas dimensões (UF, CID, sexo, idade, raça, ano/mês).",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "array",
          items: { type: "integer" },
          description: "Anos para consultar (ex: [2023, 2024])",
        },
        month: {
          type: "array",
          items: { type: "integer" },
          description: "Meses (1-12). Se omitido, todos.",
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "Lista de UFs (ex: ['SP', 'RJ']). Se omitido, todas.",
        },
        cid_chapter: {
          type: "array",
          items: { type: "integer" },
          description: "Capítulos CID-10 (1-22). Se omitido, todos.",
        },
        sex: {
          type: "string",
          enum: ["M", "F"],
          description: "Filtrar por sexo",
        },
        age_min: {
          type: "integer",
          description: "Idade mínima em anos",
        },
        age_max: {
          type: "integer",
          description: "Idade máxima em anos",
        },
        race: {
          type: "array",
          items: { type: "string" },
          description: "Raça/cor (branca, preta, parda, amarela, indigena, ignorado)",
        },
        is_csap: {
          type: "boolean",
          description: "Filtrar apenas CSAP (true) ou não-CSAP (false)",
        },
        group_by: {
          type: "array",
          items: {
            type: "string",
            enum: ["year", "month", "uf", "cid_chapter", "cid_group", "sex", "age", "race", "is_csap", "csap_group"],
          },
          description: "Dimensões para agrupamento",
        },
        limit: {
          type: "integer",
          description: "Limitar número de resultados",
        },
      },
    },
  },
  {
    name: "get_hospitalization_trends",
    description:
      "Retorna séries temporais de internações (mensal ou anual). " +
      "Útil para análise de tendências e sazonalidade.",
    inputSchema: {
      type: "object",
      properties: {
        year_start: {
          type: "integer",
          description: "Ano inicial",
        },
        year_end: {
          type: "integer",
          description: "Ano final",
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para filtrar",
        },
        cid_chapter: {
          type: "integer",
          description: "Capítulo CID-10 específico",
        },
        granularity: {
          type: "string",
          enum: ["monthly", "yearly"],
          description: "Granularidade temporal (default: yearly)",
        },
      },
      required: ["year_start", "year_end"],
    },
  },
  {
    name: "compare_regions",
    description:
      "Compara internações entre UFs ou regiões do Brasil. " +
      "Gera rankings e identifica variações regionais.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "array",
          items: { type: "integer" },
          description: "Anos para consultar",
        },
        compare_by: {
          type: "string",
          enum: ["uf", "region"],
          description: "Comparar por UF ou região (default: uf)",
        },
        cid_chapter: {
          type: "integer",
          description: "Capítulo CID-10 específico",
        },
        is_csap: {
          type: "boolean",
          description: "Filtrar apenas CSAP",
        },
        metric: {
          type: "string",
          enum: ["n", "deaths"],
          description: "Métrica para ranking (default: n)",
        },
        limit: {
          type: "integer",
          description: "Número de resultados (default: 10)",
        },
      },
    },
  },

  // --- ICSAP ---
  {
    name: "get_icsap",
    description:
      "Consulta internações por Condições Sensíveis à Atenção Primária (ICSAP). " +
      "Permite filtros por grupo CSAP, UF, município, sexo, idade e raça.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "array",
          items: { type: "integer" },
          description: "Anos para consultar",
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para filtrar",
        },
        municipality_code: {
          type: "string",
          description: "Código IBGE do município (6 dígitos)",
        },
        csap_group: {
          type: "array",
          items: { type: "string" },
          description: "Grupos CSAP (ex: ['g01', 'g05'])",
        },
        sex: {
          type: "string",
          enum: ["M", "F"],
          description: "Filtrar por sexo",
        },
        age_min: {
          type: "integer",
          description: "Idade mínima",
        },
        age_max: {
          type: "integer",
          description: "Idade máxima",
        },
        race: {
          type: "array",
          items: { type: "string" },
          description: "Raça/cor",
        },
        group_by: {
          type: "array",
          items: {
            type: "string",
            enum: ["year", "uf", "municipality_code", "csap_group", "sex", "age", "race"],
          },
          description: "Dimensões para agrupamento",
        },
      },
    },
  },
  {
    name: "get_icsap_indicators",
    description:
      "Calcula indicadores de ICSAP: percentual (ICSAP/Total×100). " +
      "Métricas-chave para avaliar a Atenção Primária.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "array",
          items: { type: "integer" },
          description: "Anos para calcular",
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para calcular",
        },
        municipality_code: {
          type: "string",
          description: "Código IBGE do município",
        },
        sex: {
          type: "string",
          enum: ["M", "F"],
          description: "Filtrar por sexo",
        },
        age_min: {
          type: "integer",
          description: "Idade mínima",
        },
        age_max: {
          type: "integer",
          description: "Idade máxima",
        },
        group_by: {
          type: "array",
          items: {
            type: "string",
            enum: ["year", "uf", "sex", "race"],
          },
          description: "Dimensões para agrupamento",
        },
      },
    },
  },
  {
    name: "rank_csap_groups",
    description:
      "Gera ranking dos 19 grupos CSAP por número de internações, " +
      "dias de internação ou valor. Identifica principais causas evitáveis.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "array",
          items: { type: "integer" },
          description: "Anos para consultar",
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para filtrar",
        },
        sex: {
          type: "string",
          enum: ["M", "F"],
          description: "Filtrar por sexo",
        },
        age_min: {
          type: "integer",
          description: "Idade mínima",
        },
        age_max: {
          type: "integer",
          description: "Idade máxima",
        },
        metric: {
          type: "string",
          enum: ["n", "days", "value", "deaths"],
          description: "Métrica para ranking (default: n)",
        },
        limit: {
          type: "integer",
          description: "Número de grupos no ranking (default: 19)",
          minimum: 1,
          maximum: 19,
        },
      },
    },
  },
  {
    name: "classify_as_csap",
    description:
      "Classifica um ou mais códigos CID-10 como CSAP ou não. " +
      "Retorna o grupo CSAP correspondente se aplicável.",
    inputSchema: {
      type: "object",
      properties: {
        cid_codes: {
          type: "array",
          items: { type: "string" },
          description: "Códigos CID-10 para classificar (ex: ['J18', 'A09', 'K35'])",
        },
      },
      required: ["cid_codes"],
    },
  },

  // --- Ferramentas que dependem de dados populacionais ---
  {
    name: "get_hospitalization_rates",
    description:
      "Calcula taxas de internação por população (por 100.000 habitantes, configurável). " +
      "Requer dados populacionais (pop_uf.parquet). Anos válidos: os cobertos por pop_uf.parquet, informados em get_available_years.population_years.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "array",
          items: { type: "integer" },
          description: "Anos para calcular",
        },
        rate_type: {
          type: "string",
          enum: ["crude", "specific"],
          description: "Tipo de taxa: crude (bruta) ou specific (específica por filtro)",
        },
        rate_per: {
          type: "integer",
          enum: [1000, 10000, 100000],
          description: "Taxa por X habitantes (default: 100000)",
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para filtrar",
        },
        cid_chapter: {
          type: "array",
          items: { type: "integer" },
          description: "Capítulos CID-10 (1-22)",
        },
        sex: {
          type: "string",
          enum: ["M", "F"],
          description: "Filtrar por sexo",
        },
        age_min: {
          type: "integer",
          description: "Idade mínima",
        },
        age_max: {
          type: "integer",
          description: "Idade máxima",
        },
        is_csap: {
          type: "boolean",
          description: "Filtrar apenas CSAP",
        },
        group_by: {
          type: "array",
          items: {
            type: "string",
            enum: ["year", "uf", "sex"],
          },
          description: "Dimensões para agrupamento",
        },
      },
    },
  },
  {
    name: "compare_icsap_trends",
    description:
      "Análise temporal comparativa de ICSAP entre UFs ou grupos CSAP. " +
      "Calcula tendências, variação anual e identifica melhores/piores desempenhos. Anos válidos: os cobertos por pop_uf.parquet, informados em get_available_years.population_years.",
    inputSchema: {
      type: "object",
      properties: {
        start_year: {
          type: "integer",
          description: "Ano inicial",
        },
        end_year: {
          type: "integer",
          description: "Ano final",
        },
        compare_by: {
          type: "string",
          enum: ["uf", "csap_group"],
          description: "Comparar por UF ou grupo CSAP",
        },
        compare_values: {
          type: "array",
          items: { type: "string" },
          description: "Valores específicos para comparar (UFs ou grupos CSAP)",
        },
        indicator: {
          type: "string",
          enum: ["percentage", "count", "rate_per_10k"],
          description: "Indicador: percentage (% ICSAP), count (número), rate_per_10k (taxa)",
        },
        include_trend_line: {
          type: "boolean",
          description: "Incluir análise de tendência linear (default: true)",
        },
      },
      required: ["start_year", "end_year"],
    },
  },
];

// =============================================================================
// HANDLERS DAS FERRAMENTAS
// =============================================================================

// --- Metadados ---

async function handleListCsapGroups(args: { group_code?: string; include_cid_codes?: boolean }) {
  const { group_code, include_cid_codes } = args;

  if (group_code) {
    const group = csapGroups.groups.find(
      (g) => g.code.toLowerCase() === group_code.toLowerCase()
    );
    if (!group) {
      return { error: `Grupo CSAP '${group_code}' não encontrado` };
    }
    return {
      group: {
        id: group.id,
        code: group.code,
        name_pt: group.name_pt,
        name_en: group.name_en,
        diagnoses: group.diagnoses,
        cid_codes: include_cid_codes ? group.cid10_all : undefined,
      },
    };
  }

  return {
    total_groups: csapGroups.groups.length,
    source: csapGroups.metadata.source,
    groups: csapGroups.groups.map((g) => ({
      code: g.code,
      name: g.name_pt,
      cid_count: g.cid10_all.length,
      cid_codes: include_cid_codes ? g.cid10_all : undefined,
    })),
  };
}

async function handleListCidChapters() {
  return {
    total_chapters: cidChapters.chapters.length,
    chapters: cidChapters.chapters,
  };
}

async function handleGetAvailableYears() {
  try {
    const years = getAvailableYears();
    return {
      years,
      data_range: {
        first_year: years[0],
        last_year: years[years.length - 1],
        total_years: years.length,
      },
      note: "Anos com dados Parquet disponíveis",
      // Intervalo de pop_uf.parquet, lido do arquivo: é o que as ferramentas de
      // taxa (get_hospitalization_rates, compare_icsap_trends) aceitam.
      population_years: await getPopulationYearRange(),
      // Frescor dos cubos frente ao espelho healthbr-data (src/freshness.ts):
      // checado em segundo plano na inicialização, sem bloquear.
      freshness: getFreshness(),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro ao listar anos",
      years: [],
    };
  }
}

async function handleClassifyAsCsap(args: { cid_codes: string[] }) {
  const { cid_codes } = args;
  const results = [];

  for (const cid of cid_codes) {
    const cidUpper = cid.toUpperCase().trim();
    const cid3 = cidUpper.substring(0, 3);
    const cid4 = cidUpper.substring(0, 4);
    let found = false;

    for (const group of csapGroups.groups) {
      for (const groupCid of group.cid10_all) {
        // Remove ponto do CID da lista para comparar
        const groupCidClean = groupCid.replace(".", "");

        // Verifica match
        if (
          cidUpper === groupCidClean ||
          cid3 === groupCidClean ||
          cid4 === groupCidClean ||
          cidUpper.startsWith(groupCidClean)
        ) {
          results.push({
            cid: cid,
            is_csap: true,
            csap_group: group.code,
            csap_name: group.name_pt,
          });
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      results.push({
        cid: cid,
        is_csap: false,
        csap_group: null,
        csap_name: null,
      });
    }
  }

  const csapCount = results.filter((r) => r.is_csap).length;
  return {
    classifications: results,
    summary: {
      total: results.length,
      csap: csapCount,
      non_csap: results.length - csapCount,
    },
  };
}

// --- Internações Gerais ---

interface GetHospitalizationsArgs {
  year?: number[];
  month?: number[];
  uf?: string[];
  cid_chapter?: number[];
  sex?: string;
  age_min?: number;
  age_max?: number;
  race?: string[];
  is_csap?: boolean;
  group_by?: string[];
  limit?: number;
}

async function handleGetHospitalizations(args: GetHospitalizationsArgs) {
  const filters: CausasFilters = {
    years: args.year,
    months: args.month,
    ufs: args.uf,
    cidChapters: args.cid_chapter,
    sex: args.sex,
    ageMin: args.age_min,
    ageMax: args.age_max,
    races: args.race,
    isCsap: args.is_csap,
  };

  try {
    const data = await queryCausas({
      filters,
      groupBy: args.group_by,
      metrics: ["n", "days", "value", "deaths"],
      orderBy: args.group_by?.includes("year")
        ? "year"
        : args.group_by?.[0] || "n_hospitalizations DESC",
      limit: args.limit,
    });

    // Calcula totais
    type HospTotals = { n: number; days: number; value: number; deaths: number };
    const totals = data.reduce<HospTotals>(
      (acc, row: Record<string, unknown>) => ({
        n: acc.n + (Number(row.n_hospitalizations) || 0),
        days: acc.days + (Number(row.total_days) || 0),
        value: acc.value + (Number(row.total_value) || 0),
        deaths: acc.deaths + (Number(row.deaths) || 0),
      }),
      { n: 0, days: 0, value: 0, deaths: 0 }
    );

    return {
      data,
      summary: {
        total_hospitalizations: totals.n,
        total_days: totals.days,
        total_value: Math.round(totals.value * 100) / 100,
        deaths: totals.deaths,
        hospital_mortality_rate:
          totals.n > 0 ? Math.round((totals.deaths / totals.n) * 10000) / 100 : 0,
        records_returned: data.length,
      },
      filters_applied: args,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro na consulta",
      data: [],
    };
  }
}

interface GetTrendsArgs {
  year_start: number;
  year_end: number;
  uf?: string[];
  cid_chapter?: number;
  granularity?: "monthly" | "yearly";
}

async function handleGetHospitalizationTrends(args: GetTrendsArgs) {
  const { year_start, year_end, uf, cid_chapter, granularity = "yearly" } = args;

  try {
    if (granularity === "monthly") {
      // Usa cubo de séries temporais
      const data = await querySeries({
        filters: {
          yearMonthStart: `${year_start}-01`,
          yearMonthEnd: `${year_end}-12`,
          ufs: uf,
          cidChapters: cid_chapter ? [cid_chapter] : undefined,
        },
        groupBy: ["year_month"],
        orderBy: "year_month",
      });

      return {
        granularity: "monthly",
        series: data,
        period: { start: `${year_start}-01`, end: `${year_end}-12` },
      };
    } else {
      // Agregação anual do cubo de causas
      const years = [];
      for (let y = year_start; y <= year_end; y++) {
        years.push(y);
      }

      const data = await queryCausas({
        filters: {
          years,
          ufs: uf,
          cidChapters: cid_chapter ? [cid_chapter] : undefined,
        },
        groupBy: ["year"],
        metrics: ["n", "deaths"],
        orderBy: "year",
      });

      return {
        granularity: "yearly",
        series: data,
        period: { start: year_start, end: year_end },
      };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro na consulta",
      series: [],
    };
  }
}

interface CompareRegionsArgs {
  year?: number[];
  compare_by?: "uf" | "region";
  cid_chapter?: number;
  is_csap?: boolean;
  metric?: "n" | "deaths";
  limit?: number;
}

async function handleCompareRegions(args: CompareRegionsArgs) {
  const { year, compare_by = "uf", cid_chapter, is_csap, metric = "n", limit = 10 } = args;

  try {
    const groupByField = compare_by === "region" ? "uf" : "uf"; // TODO: agregar por região

    const data = await queryCausas({
      filters: {
        years: year,
        cidChapters: cid_chapter ? [cid_chapter] : undefined,
        isCsap: is_csap,
      },
      groupBy: [groupByField],
      metrics: ["n", "deaths"],
      orderBy: metric === "n" ? "n_hospitalizations DESC" : "deaths DESC",
      limit,
    });

    // Adiciona ranking
    const ranking = data.map((row: Record<string, unknown>, index: number) => ({
      rank: index + 1,
      uf: row.uf,
      n_hospitalizations: row.n_hospitalizations,
      deaths: row.deaths,
      mortality_rate:
        Number(row.n_hospitalizations) > 0
          ? Math.round((Number(row.deaths) / Number(row.n_hospitalizations)) * 10000) / 100
          : 0,
    }));

    return {
      compare_by,
      metric,
      ranking,
      total_locations: data.length,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro na consulta",
      ranking: [],
    };
  }
}

// --- ICSAP ---

interface GetIcsapArgs {
  year?: number[];
  uf?: string[];
  municipality_code?: string;
  csap_group?: string[];
  sex?: string;
  age_min?: number;
  age_max?: number;
  race?: string[];
  group_by?: string[];
}

async function handleGetIcsap(args: GetIcsapArgs) {
  const filters: IcsapFilters = {
    years: args.year,
    ufs: args.uf,
    municipalityCodes: args.municipality_code ? [args.municipality_code] : undefined,
    csapGroups: args.csap_group,
    sex: args.sex,
    ageMin: args.age_min,
    ageMax: args.age_max,
    races: args.race,
  };

  try {
    const data = await queryIcsap({
      filters,
      groupBy: args.group_by,
      metrics: ["n", "n_total", "days", "value", "deaths"],
      orderBy: args.group_by?.includes("year")
        ? "year"
        : args.group_by?.[0] || "n_icsap DESC",
    });

    // Calcula totais
    type IcsapTotals = { icsap: number; total: number; days: number; value: number; deaths: number };
    const totals = data.reduce<IcsapTotals>(
      (acc, row: Record<string, unknown>) => ({
        icsap: acc.icsap + (Number(row.n_icsap) || 0),
        total: acc.total + (Number(row.n_total) || 0),
        days: acc.days + (Number(row.total_days) || 0),
        value: acc.value + (Number(row.total_value) || 0),
        deaths: acc.deaths + (Number(row.deaths) || 0),
      }),
      { icsap: 0, total: 0, days: 0, value: 0, deaths: 0 }
    );

    return {
      data,
      summary: {
        total_icsap: totals.icsap,
        total_hospitalizations: totals.total,
        icsap_percentage:
          totals.total > 0
            ? Math.round((totals.icsap / totals.total) * 10000) / 100
            : 0,
        total_days: totals.days,
        total_value: Math.round(totals.value * 100) / 100,
        deaths: totals.deaths,
        records_returned: data.length,
      },
      filters_applied: args,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro na consulta",
      data: [],
    };
  }
}

interface GetIcsapIndicatorsArgs {
  year?: number[];
  uf?: string[];
  municipality_code?: string;
  sex?: string;
  age_min?: number;
  age_max?: number;
  group_by?: string[];
}

async function handleGetIcsapIndicators(args: GetIcsapIndicatorsArgs) {
  const filters: IcsapFilters = {
    years: args.year,
    ufs: args.uf,
    municipalityCodes: args.municipality_code ? [args.municipality_code] : undefined,
    sex: args.sex,
    ageMin: args.age_min,
    ageMax: args.age_max,
  };

  try {
    const data = await calculateIcsapIndicators({
      filters,
      groupBy: args.group_by,
    });

    return {
      data,
      indicators_calculated: ["icsap_percentage"],
      note: "icsap_percentage = (n_icsap / n_total) * 100",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro no cálculo",
      data: [],
    };
  }
}

interface RankCsapGroupsArgs {
  year?: number[];
  uf?: string[];
  sex?: string;
  age_min?: number;
  age_max?: number;
  metric?: "n" | "days" | "value" | "deaths";
  limit?: number;
}

async function handleRankCsapGroups(args: RankCsapGroupsArgs) {
  const filters: IcsapFilters = {
    years: args.year,
    ufs: args.uf,
    sex: args.sex,
    ageMin: args.age_min,
    ageMax: args.age_max,
  };

  try {
    const data = await rankCsapGroups({
      filters,
      metric: args.metric || "n",
      limit: args.limit || 19,
    });

    // Adiciona nomes dos grupos e calcula percentuais
    const totalMetric = data.reduce(
      (acc, row: Record<string, unknown>) => acc + (Number(row.metric_value) || 0),
      0
    );

    const ranking = data.map((row: Record<string, unknown>, index: number) => {
      const group = csapGroups.groups.find((g) => g.code === row.csap_group);
      return {
        rank: index + 1,
        csap_group: row.csap_group,
        csap_name: group?.name_pt || "Desconhecido",
        metric_value: row.metric_value,
        pct_of_total: totalMetric > 0
          ? Math.round((Number(row.metric_value) / totalMetric) * 10000) / 100
          : 0,
        n_hospitalizations: row.n_hospitalizations,
        total_days: row.total_days,
        total_value: row.total_value,
        deaths: row.deaths,
      };
    });

    // Concentração nos top 3 e top 5
    const top3Pct = ranking.slice(0, 3).reduce((acc, r) => acc + r.pct_of_total, 0);
    const top5Pct = ranking.slice(0, 5).reduce((acc, r) => acc + r.pct_of_total, 0);

    return {
      metric: args.metric || "n",
      ranking,
      concentration: {
        top_3_percentage: Math.round(top3Pct * 100) / 100,
        top_5_percentage: Math.round(top5Pct * 100) / 100,
      },
      total_groups: ranking.length,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro no ranking",
      ranking: [],
    };
  }
}

// --- Ferramentas com dados populacionais ---

interface GetHospitalizationRatesArgs {
  year?: number[];
  rate_type?: "crude" | "specific";
  rate_per?: number;
  uf?: string[];
  cid_chapter?: number[];
  sex?: string;
  age_min?: number;
  age_max?: number;
  is_csap?: boolean;
  group_by?: string[];
}

async function handleGetHospitalizationRates(args: GetHospitalizationRatesArgs) {
  // Verifica se dados populacionais estão disponíveis
  if (!hasPopulationData()) {
    return {
      error: "Dados populacionais não disponíveis. Execute o script R build_population.R primeiro.",
      data: [],
      note: "Esta ferramenta requer os arquivos pop_uf.parquet ou pop_municipios.parquet no diretório data/",
    };
  }

  // Valida anos pelo intervalo REAL de pop_uf.parquet (lido do arquivo, não fixado aqui)
  const popRange = await getPopulationYearRange();
  if (popRange && args.year && args.year.some(y => y < popRange.first_year || y > popRange.last_year)) {
    return {
      error: `Anos devem estar entre ${popRange.first_year} e ${popRange.last_year} (intervalo com dados populacionais por UF em pop_uf.parquet).`,
      data: [],
      population_years: popRange,
      available_sih_years: getAvailableYears(),
    };
  }

  // Normaliza UFs para uppercase
  const normalizedUfs = args.uf?.map(u => u.toUpperCase());

  // Verifica se os anos solicitados existem nos dados SIH
  const availableYears = getAvailableYears();
  const requestedYears = args.year || availableYears;
  const validYears = requestedYears.filter(y => availableYears.includes(y));

  if (validYears.length === 0) {
    return {
      error: `Nenhum dos anos solicitados (${requestedYears.join(", ")}) tem dados SIH disponíveis.`,
      data: [],
      available_sih_years: availableYears,
      note: "Use get_available_years para ver anos com dados de internação.",
    };
  }

  const ratePer = args.rate_per || 100000;
  const filters: CausasFilters = {
    years: validYears,
    ufs: normalizedUfs,
    cidChapters: args.cid_chapter,
    sex: args.sex,
    ageMin: args.age_min,
    ageMax: args.age_max,
    isCsap: args.is_csap,
  };

  try {
    // Define agrupamento: se uf ou year foram passados sem group_by, agrupa automaticamente
    const groupBy = args.group_by ? [...args.group_by] : [];
    if (normalizedUfs && normalizedUfs.length > 1 && !groupBy.includes("uf")) {
      groupBy.push("uf");
    }
    if (validYears.length > 1 && !groupBy.includes("year")) {
      groupBy.push("year");
    }

    const hasUfGrouping = groupBy.includes("uf");
    const hasYearGrouping = groupBy.includes("year");

    // Busca internações
    const hospData = await queryCausas({
      filters,
      groupBy,
      metrics: ["n", "deaths"],
    });

    // Filtra resultados nulos (quando GROUP BY vazio e sem dados, retorna {null, null})
    const validHospData = (hospData as Array<Record<string, unknown>>).filter(
      row => row.n_hospitalizations !== null && row.n_hospitalizations !== undefined
    );

    if (validHospData.length === 0) {
      // Sem internações, mas podemos ainda fornecer a população
      const popYear = validYears[0];
      let population = 0;
      try {
        population = await getPopulation({ year: popYear, uf: normalizedUfs, sex: args.sex, ageMin: args.age_min, ageMax: args.age_max });
      } catch { /* ignore */ }

      return {
        data: [],
        summary: {
          total_hospitalizations: 0,
          total_population: population,
          overall_rate: 0,
          rate_per: ratePer,
          rate_type: args.rate_type || "crude",
        },
        metadata: {
          population_source: "pop_uf.parquet",
          filters_applied: { ...args, uf: normalizedUfs, year: validYears },
          note: "Nenhuma internação encontrada para os filtros aplicados.",
          available_sih_years: availableYears,
        },
      };
    }

    // Busca população correspondente e calcula taxas
    const results = [];

    for (const row of validHospData) {
      const hospYear = hasYearGrouping ? Number(row.year) : validYears[0];
      const hospUf = hasUfGrouping ? String(row.uf) : undefined;

      // Busca população para o estrato
      let population = 0;
      try {
        population = await getPopulation({
          year: hospYear,
          uf: hospUf ? [hospUf] : normalizedUfs,
          sex: args.sex,
          ageMin: args.age_min,
          ageMax: args.age_max,
        });
      } catch (popError) {
        console.error(`[get_hospitalization_rates] Erro população (year=${hospYear}, uf=${hospUf}): ${popError}`);
      }

      const nHosp = Number(row.n_hospitalizations) || 0;
      const deaths = Number(row.deaths) || 0;
      const rate = population > 0 ? (nHosp / population) * ratePer : 0;

      results.push({
        ...(hasYearGrouping ? { year: hospYear } : {}),
        ...(hasUfGrouping ? { uf: hospUf } : {}),
        n_hospitalizations: nHosp,
        deaths,
        population,
        rate_per_100k: Math.round(rate * 100) / 100,
        rate_per: ratePer,
        mortality_rate: nHosp > 0 ? Math.round((deaths / nHosp) * 10000) / 100 : 0,
      });
    }

    // Calcula totais
    const totalHosp = results.reduce((acc, r) => acc + r.n_hospitalizations, 0);
    const totalPop = results.reduce((acc, r) => acc + r.population, 0);
    const overallRate = totalPop > 0 ? (totalHosp / totalPop) * ratePer : 0;

    return {
      data: results,
      summary: {
        total_hospitalizations: totalHosp,
        total_population: totalPop,
        overall_rate: Math.round(overallRate * 100) / 100,
        rate_per: ratePer,
        rate_type: args.rate_type || "crude",
      },
      metadata: {
        population_source: "pop_uf.parquet",
        filters_applied: { ...args, uf: normalizedUfs, year: validYears },
      },
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro ao calcular taxas",
      data: [],
    };
  }
}

interface CompareIcsapTrendsArgs {
  start_year: number;
  end_year: number;
  compare_by?: "uf" | "csap_group";
  compare_values?: string[];
  indicator?: "percentage" | "count" | "rate_per_10k";
  include_trend_line?: boolean;
}

async function handleCompareIcsapTrends(args: CompareIcsapTrendsArgs) {
  const { start_year, end_year, compare_by, indicator, include_trend_line } = args;
  const indicatorType = indicator || "percentage";
  const includeTrend = include_trend_line !== false;

  // Validação de anos pelo intervalo REAL de pop_uf.parquet (lido do arquivo, não fixado aqui)
  const popRange = await getPopulationYearRange();
  if (popRange && (start_year < popRange.first_year || end_year > popRange.last_year)) {
    return {
      error: `Anos devem estar entre ${popRange.first_year} e ${popRange.last_year} (intervalo com dados populacionais em pop_uf.parquet).`,
      series: [],
      population_years: popRange,
      available_sih_years: getAvailableYears(),
    };
  }

  // Se usa taxa, verifica população
  if (indicatorType === "rate_per_10k" && !hasPopulationData()) {
    return {
      error: "Taxa por população requer dados populacionais. Execute build_population.R primeiro.",
      series: [],
    };
  }

  // Normaliza compare_values (UFs para uppercase)
  const compare_values = args.compare_values?.map(v =>
    compare_by === "uf" ? v.toUpperCase() : v
  );

  // Filtra anos pelos disponíveis no SIH
  const allYears = Array.from({ length: end_year - start_year + 1 }, (_, i) => start_year + i);
  const availableYears = getAvailableYears();
  const years = allYears.filter(y => availableYears.includes(y));

  if (years.length === 0) {
    return {
      error: `Nenhum dos anos no intervalo ${start_year}-${end_year} tem dados SIH disponíveis.`,
      series: [],
      available_sih_years: availableYears,
    };
  }

  try {
    const filters: IcsapFilters = {
      years,
      csapGroups: compare_by === "csap_group" ? compare_values : undefined,
      ufs: compare_by === "uf" ? compare_values : undefined,
    };

    // Determina groupBy baseado em compare_by
    const groupBy = ["year"];
    if (compare_by) {
      groupBy.push(compare_by);
    }

    // Busca dados ICSAP
    const data = await calculateIcsapIndicators({
      filters,
      groupBy,
    });

    // Organiza série temporal
    const seriesMap: Record<string, Record<number, { icsap: number; total: number; population?: number }>> = {};

    for (const row of data as Array<Record<string, unknown>>) {
      const year = Number(row.year);
      const compareKey = compare_by ? String(row[compare_by]) : "total";
      const icsap = Number(row.n_icsap) || 0;
      const total = Number(row.n_total) || 0;

      if (!seriesMap[compareKey]) {
        seriesMap[compareKey] = {};
      }
      seriesMap[compareKey][year] = { icsap, total };
    }

    // Se precisa de taxa, busca população por ano
    if (indicatorType === "rate_per_10k") {
      for (const compareKey of Object.keys(seriesMap)) {
        for (const year of years) {
          if (seriesMap[compareKey][year]) {
            try {
              const ufFilter = compare_by === "uf" ? [compareKey] : undefined;
              const pop = await getPopulation({ year, uf: ufFilter });
              seriesMap[compareKey][year].population = pop;
            } catch {
              seriesMap[compareKey][year].population = 0;
            }
          }
        }
      }
    }

    // Constrói séries e calcula indicadores
    const series: Array<Record<string, unknown>> = [];
    const trendData: Record<string, { values: number[]; years: number[] }> = {};

    for (const year of years) {
      const row: Record<string, unknown> = { year };

      for (const compareKey of Object.keys(seriesMap)) {
        const entry = seriesMap[compareKey][year];
        if (entry) {
          let value: number;

          switch (indicatorType) {
            case "count":
              value = entry.icsap;
              break;
            case "rate_per_10k":
              value = entry.population && entry.population > 0
                ? (entry.icsap / entry.population) * 10000
                : 0;
              break;
            case "percentage":
            default:
              value = entry.total > 0 ? (entry.icsap / entry.total) * 100 : 0;
          }

          row[compareKey] = Math.round(value * 100) / 100;

          // Acumula para cálculo de tendência
          if (!trendData[compareKey]) {
            trendData[compareKey] = { values: [], years: [] };
          }
          trendData[compareKey].values.push(value);
          trendData[compareKey].years.push(year);
        }
      }

      series.push(row);
    }

    // Calcula tendências (regressão linear simples)
    const trends: Record<string, {
      slope: number;
      direction: "increasing" | "decreasing" | "stable";
      avg_annual_change: number;
      start_value: number;
      end_value: number;
      change_pct: number;
    }> = {};

    if (includeTrend) {
      for (const [compareKey, td] of Object.entries(trendData)) {
        const n = td.values.length;
        if (n < 2) continue;

        // Regressão linear simples
        const sumX = td.years.reduce((a, b) => a + b, 0);
        const sumY = td.values.reduce((a, b) => a + b, 0);
        const sumXY = td.years.reduce((acc, x, i) => acc + x * td.values[i], 0);
        const sumX2 = td.years.reduce((acc, x) => acc + x * x, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const startValue = td.values[0];
        const endValue = td.values[n - 1];
        const changePct = startValue > 0 ? ((endValue - startValue) / startValue) * 100 : 0;

        trends[compareKey] = {
          slope: Math.round(slope * 1000) / 1000,
          direction: slope > 0.1 ? "increasing" : slope < -0.1 ? "decreasing" : "stable",
          avg_annual_change: Math.round(slope * 100) / 100,
          start_value: Math.round(startValue * 100) / 100,
          end_value: Math.round(endValue * 100) / 100,
          change_pct: Math.round(changePct * 100) / 100,
        };
      }
    }

    // Identifica melhor/pior desempenho (para percentage, menor é melhor)
    let bestPerformer: string | undefined;
    let worstPerformer: string | undefined;

    if (Object.keys(trends).length > 1) {
      const sortedByChange = Object.entries(trends).sort((a, b) => a[1].change_pct - b[1].change_pct);
      if (indicatorType === "percentage") {
        // Para porcentagem ICSAP, queda é melhor
        bestPerformer = sortedByChange[0][0];
        worstPerformer = sortedByChange[sortedByChange.length - 1][0];
      } else {
        // Para contagem e taxa, menor variação positiva ou maior queda é melhor
        bestPerformer = sortedByChange[0][0];
        worstPerformer = sortedByChange[sortedByChange.length - 1][0];
      }
    }

    return {
      indicator: indicatorType,
      period: { start: start_year, end: end_year },
      compare_by: compare_by || "total",
      series,
      trends: includeTrend ? trends : undefined,
      summary: {
        best_performer: bestPerformer,
        worst_performer: worstPerformer,
        note: indicatorType === "percentage"
          ? "Para % ICSAP, queda indica melhoria na Atenção Primária"
          : undefined,
      },
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Erro na análise de tendências",
      series: [],
    };
  }
}

// =============================================================================
// SERVIDOR MCP
// =============================================================================

const server = new Server(
  {
    name: "sih-br-mcp",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handler: Lista ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handler: Executa ferramenta
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      // Metadados
      case "list_csap_groups":
        result = await handleListCsapGroups(args as { group_code?: string; include_cid_codes?: boolean });
        break;
      case "list_cid_chapters":
        result = await handleListCidChapters();
        break;
      case "get_available_years":
        result = await handleGetAvailableYears();
        break;
      case "classify_as_csap":
        result = await handleClassifyAsCsap(args as { cid_codes: string[] });
        break;

      // Internações Gerais
      case "get_hospitalizations":
        result = await handleGetHospitalizations(args as GetHospitalizationsArgs);
        break;
      case "get_hospitalization_trends":
        result = await handleGetHospitalizationTrends(args as unknown as GetTrendsArgs);
        break;
      case "compare_regions":
        result = await handleCompareRegions(args as CompareRegionsArgs);
        break;

      // ICSAP
      case "get_icsap":
        result = await handleGetIcsap(args as GetIcsapArgs);
        break;
      case "get_icsap_indicators":
        result = await handleGetIcsapIndicators(args as GetIcsapIndicatorsArgs);
        break;
      case "rank_csap_groups":
        result = await handleRankCsapGroups(args as RankCsapGroupsArgs);
        break;

      // Ferramentas com dados populacionais
      case "get_hospitalization_rates":
        result = await handleGetHospitalizationRates(args as unknown as GetHospitalizationRatesArgs);
        break;
      case "compare_icsap_trends":
        result = await handleCompareIcsapTrends(args as unknown as CompareIcsapTrendsArgs);
        break;

      default:
        return {
          content: [
            {
              type: "text",
              text: `Ferramenta desconhecida: ${name}`,
            },
          ],
          isError: true,
        };
    }

    // Toda resposta sai com o bloco de proveniência do contrato (concise):
    // fonte, URL, safra, retrieved_at, citação e licença — ver src/provenance.ts.
    return withProvenance(result, provenanceFor(name, args));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Erro ao executar ${name}: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// =============================================================================
// INICIALIZAÇÃO
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SIH-BR-MCP Server iniciado");
  // Frescor dos cubos: sonda o manifesto do espelho em segundo plano (512
  // bytes; só baixa os 10 MB se o manifesto mudou), com timeout curto. Não
  // espera — a primeira ferramenta chamada antes do veredito vê `pending`.
  void startFreshnessCheck();
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});

// Cleanup ao encerrar
process.on("SIGINT", async () => {
  await closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeDatabase();
  process.exit(0);
});
