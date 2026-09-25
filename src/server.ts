/**
 * Factory do servidor MCP (SDK v2). Sem efeito colateral: cada chamada devolve
 * um McpServer novo com as doze ferramentas registradas sobre callTool()
 * (src/tools.ts). Quem escolhe o transporte é quem chama:
 *
 * - src/index.ts (stdio, pacote npm): uma instância por conexão, via serveStdio.
 * - src/http.ts (Streamable HTTP, container): uma instância POR REQUEST —
 *   modelo stateless que o SDK recomenda para servidores "API-style"; qualquer
 *   instância atende qualquer request, sem sessão nem eventStore.
 *
 * Os JSON Schemas das ferramentas continuam os mesmos (fromJsonSchema): a
 * superfície que o cliente vê — nome, descrição, inputSchema e, desde 0.16.0,
 * outputSchema — é a gravada em baselines/surface-stdio.json; título e
 * anotações são o que entra a mais.
 */
import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type JsonSchemaValidatorResult,
  type ToolAnnotations,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

import { announceServedVersions } from "./discover.js";
import { SERVER_VERSION } from "./provenance.js";
import { callTool, tools, type ToolArgs } from "./tools.js";

export const SERVER_NAME = "sih-br-mcp";
export const SERVER_WEBSITE_URL = "https://sih.sidneybissoli.com";
// O título canônico do produto, e ele mora em TRÊS superfícies que têm de
// concordar: este SERVER_TITLE (o que o cliente MCP mostra no handshake), o
// `title` do server.json (o que o registro oficial e os diretórios exibem) e o
// SERVER_CONFIG do worker/. Em 13/09/2026 a ação GEO reescreveu os dois
// últimos para o vocabulário da pergunta — "DATASUS", "hospital admissions",
// "AIH" — e este ficou para trás, então o conector anunciava um nome e o
// diretório outro. Passou despercebido por um dia porque os testes do worker,
// que comparam os três, não rodavam no CI (corrigido em 14/09).
export const SERVER_TITLE = "DATASUS SIH/SUS — Brazil Hospital Admissions (AIH) MCP";

/**
 * Instruções do handshake MCP (`initialize.result.instructions`): o que o
 * servidor cobre, o fluxo típico entre as doze ferramentas e quando o cliente
 * NÃO deve usá-lo (critério de review de conectores da Anthropic; regra
 * `server_instructions_present` do mcpscore, reprovada até 25/09/2026). Em
 * inglês, como o título e o server.json — é o texto que o modelo lê, e o
 * vocabulário da pergunta em inglês ("hospital admissions", "ICD-10", "AIH") é
 * o que a ação GEO de 13/09/2026 fixou para as superfícies públicas. As doze
 * ferramentas são citadas pelo nome, e tests/instructions.test.ts prende os
 * dois lados: todo nome citado existe, e toda ferramenta é citada — uma
 * ferramenta nova sem lugar no fluxo reprova ali, não no chat.
 */
export const SERVER_INSTRUCTIONS =
  "Brazilian hospital admissions from DATASUS SIH/SUS (AIH records, 1992-2025), read from " +
  "pre-aggregated public cubes of the healthbr-data Parquet mirror, never from the FTP or " +
  "TabNet: causes by ICD-10 chapter and group (ICD-9 before 1998), monthly series, ambulatory " +
  "care sensitive conditions (ICSAP, the Brazilian list) and crude, age-specific or " +
  "age-standardized rates per 100,000 by state and municipality. Every stratum carries " +
  "admissions, length of stay, amount paid by SUS and deaths; every response carries a " +
  "provenance block with the data vintage and the citation. Typical flow: get_available_years " +
  "first (which years each cube covers), then get_hospitalizations for counts by cause, place, " +
  "age, sex and race, get_hospitalization_trends for monthly or annual series, " +
  "get_hospitalization_rates and compare_regions for rates; get_icsap, get_icsap_indicators, " +
  "rank_csap_groups and compare_icsap_trends for ICSAP; list_cid_chapters, list_csap_groups and " +
  "classify_as_csap resolve codes and groups before querying. Do not use this server for " +
  "individual AIH records, for variables the cubes do not carry (procedure performed, facility " +
  "CNES, secondary diagnosis) or for other DATASUS systems (SIM, SINASC, SIA, SINAN): use " +
  "microdatasus, PySUS or the healthbr-data mirror for those.";

// Review de conectores do claude.ai (claude.com/docs/connectors/building/
// review-criteria, lido em 08/09/2026): toda ferramenta com `title` e
// `readOnlyHint`. As doze só leem: cubos agregados e população, do disco ou
// do canal público healthbr-data — nada é escrito fora do cache local, e a
// mesma chamada devolve o mesmo resultado enquanto o canal não republicar.
// openWorldHint fica false: a única fonte é um canal fixo e versionado, não
// uma busca aberta na internet.
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Valida os ARGUMENTOS contra o JSON Schema publicado, e nomeia a chave errada.
 *
 * Os esquemas fecham com `additionalProperties: false` desde 11/09/2026 (ver
 * src/tools.ts): sem isso a chave desconhecida era descartada em silêncio, o
 * default do parâmetro que faltou entrava no lugar e a ferramenta respondia
 * OUTRA pergunta com cara de resposta — `list_csap_groups({group_codes:"g01"})`,
 * no plural, devolvia os 19 grupos como se fosse o pedido.
 *
 * O validador vem explícito pelo MESMO motivo do bcb: o default do SDK recusa
 * com "data must NOT have additional properties", que não diz QUAL chave, e o
 * do cf-worker responde `Property "group_codes" does not match additional
 * properties schema`. Nomear a chave é o que faz o modelo se corrigir na
 * chamada seguinte em vez de repetir o engano. Ele roda nos dois runtimes
 * (stdio e container) — o provider baseado em ajv compila com `new Function`
 * e não é portátil.
 */
const validadorDeEntrada = new CfWorkerJsonSchemaValidator();

/**
 * O `outputSchema` é ANUNCIADO verbatim, não imposto em runtime (molde do bcb,
 * `passthroughSchema` em register.ts). Quem prova que toda resposta obedece ao
 * esquema é tests/output-contract.test.ts, com o mesmo validador do SDK, caso
 * cheio e caso magro por ferramenta. Validar aqui também transformaria um
 * descompasso entre esquema e resposta em erro para o usuário em produção —
 * o lugar de pegar isso é o CI, não o chat.
 */
const validadorPermissivo: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown): JsonSchemaValidatorResult<T> => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: SERVER_TITLE,
      // O site e o ícone no handshake (campos da revisão 2025-11-25). As
      // MESMAS URLs do server.json: worker/tests/icon.test.ts prende os três
      // lugares (bytes no Worker, serverInfo aqui, manifesto no registro)
      // para o handshake e os diretórios nunca mostrarem imagens diferentes.
      websiteUrl: SERVER_WEBSITE_URL,
      icons: [{ src: `${SERVER_WEBSITE_URL}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }],
    },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // server/discover anuncia todas as revisões atendidas, não só as modernas —
  // ver src/discover.ts. Antes das tools: se o SDK mudar por baixo, o servidor
  // falha ao construir e não meio-construído.
  announceServedVersions(server);

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<ToolArgs>(tool.inputSchema as JsonSchemaType, validadorDeEntrada),
        outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType, validadorPermissivo),
        annotations: READ_ONLY,
      },
      (args) => callTool(tool.name, args),
    );
  }
  return server;
}
