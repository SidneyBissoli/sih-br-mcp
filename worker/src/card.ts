/**
 * Server card estático (`/.well-known/mcp/server-card.json`) para scanners de
 * registry que o leem em vez de conectar ao /mcp.
 *
 * A lista de ferramentas vem do CONTAINER — initialize + tools/list por
 * JSON-RPC, uma vez por isolate — para que o card nunca divirja do que o /mcp
 * anuncia. Se o container não responde (cold start estourou, deploy em curso),
 * o card sai com a lista estática de src/config.ts (só nome e título) e um
 * campo `source: "static"` dizendo isso, em vez de 500: o scanner que chegou
 * não volta tão cedo.
 */

import { SERVER_CONFIG, TOOLS } from "./config.js";
import { logger } from "./logger.js";

interface JsonRpcResponse {
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** Lê uma resposta Streamable HTTP (JSON direto ou SSE com um evento `message`). */
export async function readJsonRpcResponse(res: Response): Promise<JsonRpcResponse> {
  const texto = await res.text();
  const tipo = res.headers.get("content-type") ?? "";
  if (tipo.includes("text/event-stream")) {
    for (const linha of texto.split("\n")) {
      if (linha.startsWith("data:")) return JSON.parse(linha.slice(5).trim()) as JsonRpcResponse;
    }
    throw new Error("SSE sem evento data");
  }
  return JSON.parse(texto) as JsonRpcResponse;
}

let cardCache: string | undefined;

/** Monta o card perguntando ao container por `fetch` (função injetada — testável sem container). */
export async function buildServerCard(
  containerFetch: (req: Request) => Promise<Response>,
): Promise<string> {
  const base = {
    name: SERVER_CONFIG.name,
    version: SERVER_CONFIG.version,
    websiteUrl: SERVER_CONFIG.websiteUrl,
    repository: SERVER_CONFIG.repositoryUrl,
  };
  try {
    const rpc = async (id: number, method: string, params?: unknown) =>
      readJsonRpcResponse(
        await containerFetch(
          new Request(`http://container${SERVER_CONFIG.mcpRoute}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          }),
        ),
      );
    const init = await rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "server-card-builder", version: SERVER_CONFIG.version },
    });
    if (init.error || !init.result) throw new Error(init.error?.message ?? "initialize sem result");
    const lista = await rpc(2, "tools/list");
    if (lista.error || !lista.result) throw new Error(lista.error?.message ?? "tools/list sem result");
    return JSON.stringify({
      ...base,
      protocolVersion: init.result.protocolVersion,
      capabilities: init.result.capabilities,
      instructions: init.result.instructions,
      tools: lista.result.tools,
      resources: [],
      prompts: [],
      source: "container",
    });
  } catch (err) {
    logger.warn("server_card_fallback", { err: String(err) });
    return JSON.stringify({
      ...base,
      tools: TOOLS.map((t) => ({ name: t.name, title: t.title })),
      resources: [],
      prompts: [],
      source: "static",
    });
  }
}

/** Card com cache por isolate — só cacheia o resultado vindo do container. */
export async function getServerCard(
  containerFetch: (req: Request) => Promise<Response>,
): Promise<string> {
  if (cardCache) return cardCache;
  const card = await buildServerCard(containerFetch);
  if (card.includes('"source":"container"')) cardCache = card;
  return card;
}

/** Zera o cache — somente para testes. */
export function _resetServerCard(): void {
  cardCache = undefined;
}
