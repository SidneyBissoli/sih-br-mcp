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
 * superfície que o cliente vê — nome, descrição, inputSchema — é a gravada em
 * baselines/surface-stdio.json; título e anotações são o que entra a mais.
 */
import { McpServer, fromJsonSchema, type JsonSchemaType, type ToolAnnotations } from "@modelcontextprotocol/server";

import { SERVER_VERSION } from "./provenance.js";
import { callTool, tools, type ToolArgs } from "./tools.js";

export const SERVER_NAME = "sih-br-mcp";
export const SERVER_TITLE = "SIH/SUS Brasil MCP";

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

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE },
    { capabilities: { tools: {} } },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<ToolArgs>(tool.inputSchema as JsonSchemaType),
        annotations: READ_ONLY,
      },
      (args) => callTool(tool.name, args),
    );
  }
  return server;
}
