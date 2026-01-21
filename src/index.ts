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

import { getDatabase, closeDatabase } from "./db/duckdb.js";

// Importa dados de referência
import csapGroups from "./data/csap-groups.json" with { type: "json" };
import cidChapters from "./data/cid-chapters.json" with { type: "json" };
import brazilRegions from "./data/brazil-regions.json" with { type: "json" };

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
      "Retorna os anos disponíveis nos dados do SIH-SUS (1998-2024).",
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
        year_start: {
          type: "integer",
          description: "Ano inicial (1998-2024)",
          minimum: 1998,
          maximum: 2024,
        },
        year_end: {
          type: "integer",
          description: "Ano final (1998-2024)",
          minimum: 1998,
          maximum: 2024,
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
        age_group: {
          type: "array",
          items: { type: "string" },
          description: "Faixas etárias (ex: ['0-4', '5-9', '60-69'])",
        },
        group_by: {
          type: "array",
          items: {
            type: "string",
            enum: ["year", "month", "uf", "cid_chapter", "sex", "age_group", "race"],
          },
          description: "Dimensões para agrupamento",
        },
      },
      required: ["year_start", "year_end"],
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
          minimum: 1998,
          maximum: 2024,
        },
        year_end: {
          type: "integer",
          description: "Ano final",
          minimum: 1998,
          maximum: 2024,
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
    name: "get_hospitalization_rates",
    description:
      "Calcula taxas de internação por 10.000 habitantes. " +
      "Inclui taxa bruta e mortalidade hospitalar.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "Ano de referência",
          minimum: 2000,
          maximum: 2024,
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para calcular",
        },
        cid_chapter: {
          type: "integer",
          description: "Capítulo CID-10 específico",
        },
        sex: {
          type: "string",
          enum: ["M", "F"],
          description: "Filtrar por sexo",
        },
        age_group: {
          type: "array",
          items: { type: "string" },
          description: "Faixas etárias específicas",
        },
      },
      required: ["year"],
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
          type: "integer",
          description: "Ano de referência",
          minimum: 1998,
          maximum: 2024,
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
        metric: {
          type: "string",
          enum: ["n", "rate", "mortality"],
          description: "Métrica para ranking (default: n)",
        },
      },
      required: ["year"],
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
        year_start: {
          type: "integer",
          description: "Ano inicial",
          minimum: 1998,
          maximum: 2024,
        },
        year_end: {
          type: "integer",
          description: "Ano final",
          minimum: 1998,
          maximum: 2024,
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
        age_group: {
          type: "array",
          items: { type: "string" },
          description: "Faixas etárias",
        },
        group_by: {
          type: "array",
          items: {
            type: "string",
            enum: ["year", "uf", "municipality_code", "csap_group", "sex", "age_group", "race"],
          },
          description: "Dimensões para agrupamento",
        },
      },
      required: ["year_start", "year_end"],
    },
  },
  {
    name: "get_icsap_indicators",
    description:
      "Calcula indicadores de ICSAP: percentual (ICSAP/Total×100) e " +
      "taxa por 10.000 habitantes. Métricas-chave para avaliar a Atenção Primária.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "integer",
          description: "Ano de referência",
          minimum: 2000,
          maximum: 2024,
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
        age_group: {
          type: "array",
          items: { type: "string" },
          description: "Faixas etárias",
        },
      },
      required: ["year"],
    },
  },
  {
    name: "compare_icsap_trends",
    description:
      "Compara tendências temporais de ICSAP entre diferentes UFs, " +
      "municípios ou grupos CSAP. Útil para avaliar impacto de políticas de saúde.",
    inputSchema: {
      type: "object",
      properties: {
        year_start: {
          type: "integer",
          description: "Ano inicial",
          minimum: 1998,
          maximum: 2024,
        },
        year_end: {
          type: "integer",
          description: "Ano final",
          minimum: 1998,
          maximum: 2024,
        },
        compare_entities: {
          type: "array",
          items: { type: "string" },
          description: "UFs ou códigos de município para comparar",
        },
        indicator: {
          type: "string",
          enum: ["percentage", "rate", "absolute"],
          description: "Indicador para comparar (default: percentage)",
        },
      },
      required: ["year_start", "year_end", "compare_entities"],
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
          type: "integer",
          description: "Ano de referência",
          minimum: 1998,
          maximum: 2024,
        },
        uf: {
          type: "array",
          items: { type: "string" },
          description: "UFs para filtrar",
        },
        metric: {
          type: "string",
          enum: ["n", "days", "value", "deaths"],
          description: "Métrica para ranking (default: n)",
        },
        top_n: {
          type: "integer",
          description: "Número de grupos no ranking (default: 10)",
          minimum: 1,
          maximum: 19,
        },
      },
      required: ["year"],
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
];

// =============================================================================
// HANDLERS DAS FERRAMENTAS
// =============================================================================

async function handleListCsapGroups(args: { group_code?: string }) {
  const { group_code } = args;

  if (group_code) {
    const group = csapGroups.groups.find(
      (g) => g.code.toLowerCase() === group_code.toLowerCase()
    );
    if (!group) {
      return { error: `Grupo CSAP '${group_code}' não encontrado` };
    }
    return { group };
  }

  return {
    total_groups: csapGroups.groups.length,
    source: csapGroups.metadata.source,
    groups: csapGroups.groups.map((g) => ({
      code: g.code,
      name: g.name_pt,
      cid_count: g.cid10_all.length,
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
  return {
    min_year: 1998,
    max_year: 2024,
    total_years: 27,
    note: "CID-10 implementado no SIH-SUS em janeiro/1998",
  };
}

async function handleClassifyAsCsap(args: { cid_codes: string[] }) {
  const { cid_codes } = args;
  const results = [];

  for (const cid of cid_codes) {
    const cidUpper = cid.toUpperCase().trim();
    let found = false;

    for (const group of csapGroups.groups) {
      // Verifica se o CID está na lista do grupo
      for (const groupCid of group.cid10_all) {
        // Suporta códigos exatos e ranges
        if (groupCid.includes("-")) {
          // Range: ex "A00-A09"
          const [start, end] = groupCid.split("-");
          if (cidUpper >= start && cidUpper <= end) {
            results.push({
              cid: cid,
              is_csap: true,
              csap_group: group.code,
              csap_name: group.name_pt,
            });
            found = true;
            break;
          }
        } else if (cidUpper.startsWith(groupCid) || cidUpper === groupCid) {
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

  return { classifications: results };
}

// Handlers placeholder para ferramentas que precisam do DuckDB
async function handleDatabaseQuery(toolName: string, args: Record<string, unknown>) {
  // TODO: Implementar queries no Passo 4
  return {
    error: "Ferramenta ainda não implementada. Aguardando dados Parquet.",
    tool: toolName,
    args: args,
  };
}

// =============================================================================
// SERVIDOR MCP
// =============================================================================

const server = new Server(
  {
    name: "sih-br-mcp",
    version: "0.1.0",
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
      // Metadados (funcionais)
      case "list_csap_groups":
        result = await handleListCsapGroups(args as { group_code?: string });
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

      // Ferramentas que precisam de dados (placeholder)
      case "get_hospitalizations":
      case "get_hospitalization_trends":
      case "get_hospitalization_rates":
      case "compare_regions":
      case "get_icsap":
      case "get_icsap_indicators":
      case "compare_icsap_trends":
      case "rank_csap_groups":
        result = await handleDatabaseQuery(name, args as Record<string, unknown>);
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
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
