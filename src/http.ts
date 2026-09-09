#!/usr/bin/env node

/**
 * Entrada Streamable HTTP (PLAN-004): o que roda no container atrás do Worker
 * de borda. Mesmas ferramentas do stdio (src/server.ts → src/tools.ts), outro
 * transporte.
 *
 * Rotas:
 *   POST/GET/DELETE /mcp  — Streamable HTTP, STATELESS: McpServer e transporte
 *                           novos por request (sessionIdGenerator: undefined),
 *                           o modelo que o SDK recomenda para servidores
 *                           "API-style"/multi-instância. Resposta em SSE
 *                           (default do SDK): a série de 34 anos leva ~30 s e a
 *                           conexão precisa ficar viva pelo proxy.
 *   GET /healthz          — 200 com versão e anos em cache; NÃO abre o DuckDB
 *                           nem baixa nada (é o que o Worker sonda antes de
 *                           encaminhar).
 *
 * O que NÃO fica aqui, de propósito: validação de Origin/Host, rate limit,
 * bearer, Analytics Engine — tudo no Worker de borda, que é o único que fala
 * com este processo (as opções allowedHosts/allowedOrigins do SDK estão
 * deprecated em favor de middleware externo).
 *
 * Env: PORT (8080), SIH_HTTP_HOST (0.0.0.0) e as mesmas do stdio
 * (SIH_CACHE_DIR, SIH_DATA_DIR, SIH_CUBES_BASE_URL, SIH_FRESHNESS_CHECK...).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

import { closeDatabase, getAvailableYears } from "./db/duckdb.js";
import { startFreshnessCheck } from "./freshness.js";
import { SERVER_VERSION } from "./provenance.js";
import { createServer, SERVER_NAME } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.SIH_HTTP_HOST ?? "0.0.0.0";
export const MCP_PATH = "/mcp";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // Fecha os dois quando a resposta termina (ou o cliente desiste): sem isso
  // cada request deixaria um par servidor/transporte vivo até o GC.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok", server: SERVER_NAME, version: SERVER_VERSION, cached_years: getAvailableYears() });
    return;
  }

  if (url.pathname === MCP_PATH) {
    handleMcp(req, res).catch((error) => {
      console.error("[http] erro no /mcp:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      } else {
        res.end();
      }
    });
    return;
  }

  sendJson(res, 404, { error: "not found", routes: [MCP_PATH, "/healthz"] });
});

// A série de 34 anos leva ~30 s: o request não pode morrer pelo relógio do
// Node antes de a ferramenta responder (default requestTimeout = 300 s, ok;
// headersTimeout 60 s só conta até os cabeçalhos chegarem).
httpServer.requestTimeout = 300_000;

httpServer.listen(PORT, HOST, () => {
  console.error(`[http] ${SERVER_NAME} ${SERVER_VERSION} em http://${HOST}:${PORT}${MCP_PATH}`);
});

// Frescor dos cubos: uma sonda por processo, em segundo plano, reagendada a
// cada 6 h (src/freshness.ts) — num servidor longo é o que mantém o veredito.
void startFreshnessCheck();

async function shutdown(signal: string): Promise<void> {
  console.error(`[http] ${signal}: encerrando`);
  httpServer.close();
  await closeDatabase();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
