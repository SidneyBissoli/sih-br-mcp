#!/usr/bin/env node

/**
 * Entrada Streamable HTTP (PLAN-004): o que roda no container atrás do Worker
 * de borda. Mesmas ferramentas do stdio (src/server.ts → src/tools.ts), outro
 * transporte.
 *
 * Rotas:
 *   POST/GET/DELETE /mcp  — Streamable HTTP pelo `createMcpHandler` do SDK,
 *                           adaptado ao node:http por `toNodeHandler`: serve
 *                           as DUAS eras do protocolo — 2026-07-28 (envelope
 *                           por request, `server/discover`) e 2025 pelo
 *                           fallback STATELESS (McpServer e transporte novos
 *                           por request, `sessionIdGenerator: undefined`, o
 *                           mesmo modelo "API-style" de antes). Resposta em
 *                           SSE nas duas eras (`responseMode: "sse"`), com
 *                           keepalive: a série de 34 anos leva ~30 s e a
 *                           conexão precisa ficar viva pelo proxy.
 *   GET /healthz          — 200 com versão e anos em cache; NÃO abre o DuckDB
 *                           nem baixa nada (é o que o Worker sonda antes de
 *                           encaminhar).
 *
 * POR QUE `createMcpHandler`, E NÃO `server.connect(transport)` + `handleRequest`.
 * Até 25/09/2026 era o segundo — o caminho LEGADO do SDK: só a era 2025, sem
 * `server/discover`, e o cabeçalho MCP-Protocol-Version: 2026-07-28 voltava
 * HTTP 400 "Unsupported protocol version". O mcpscore lia isso como
 * `modern_lifecycle_support: false` e reprovava `protocol_version_latest`
 * (MEDIUM, 2 dos 4 pontos que faltavam para 76/76). A entrada dual-era é a
 * mesma dos seis irmãos em Worker (`createMcpHandler` direto) e a mesma do
 * stdio deste pacote (`serveStdio`, que já era dual-era). O contêiner continua
 * sem validar Host/Origin — a entrada é "deliberately validation-free", e o
 * Worker é o único que fala com ele.
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
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { closeDatabase, getAvailableYears } from "./db/duckdb.js";
import { startFreshnessCheck } from "./freshness.js";
import { unknownCursorErrorFromText } from "./pagination.js";
import { SERVER_VERSION } from "./provenance.js";
import { createServer, SERVER_NAME } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.SIH_HTTP_HOST ?? "0.0.0.0";
export const MCP_PATH = "/mcp";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// UM handler por processo, UMA instância de servidor por request (a factory
// é chamada a cada exchange, nas duas eras). O handler fecha o que abre.
const mcpHandler = createMcpHandler(() => createServer(), {
  legacy: "stateless",
  responseMode: "sse",
  onerror: (error) => console.error("[http] erro do handler MCP:", error),
});
const serveMcp = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("[http] erro no adaptador node:", error),
});

/**
 * Um `IncomingMessage` já lido, reapresentado ao adaptador do SDK como o
 * mínimo que ele consome (método, URL, cabeçalhos e o corpo como iterável).
 * O guarda de cursor precisa do corpo ANTES do handler, e o stream do Node só
 * se lê uma vez.
 */
function reapresentado(req: IncomingMessage, corpo: Buffer): NodeIncomingMessageLike {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    async *[Symbol.asyncIterator]() {
      yield corpo;
    },
  };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    await serveMcp(req, res);
    return;
  }
  const pedacos: Buffer[] = [];
  for await (const pedaco of req) pedacos.push(Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(String(pedaco)));
  const corpo = Buffer.concat(pedacos);
  // Cursor de paginação inválido → -32602 (src/pagination.ts), a mesma recusa
  // do stdio. 200 com o erro JSON-RPC no corpo: a falha é de protocolo, não de
  // HTTP — é assim que o cliente MCP lê o código.
  const recusa = unknownCursorErrorFromText(corpo.toString("utf8"));
  if (recusa) {
    sendJson(res, 200, recusa);
    return;
  }
  await serveMcp(reapresentado(req, corpo), res);
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
  // Saída garantida em 5 s: `closeDatabase()` espera a consulta em curso
  // terminar (closeSync do DuckDB), e no rollout do Cloudflare Containers o
  // SIGTERM chegou no meio da série de 34 anos — o processo velho drenou por
  // minutos e o container novo não subia ("The container is not running,
  // consider calling start()" em toda chamada). Medido em 09/09/2026.
  setTimeout(() => process.exit(0), 5_000).unref();
  httpServer.close();
  await mcpHandler.close().catch(() => undefined);
  await closeDatabase();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
