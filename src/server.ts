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
    { capabilities: { tools: {} } },
  );
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
