/**
 * Server card (`/.well-known/mcp/server-card.json`) para scanners de registry
 * que o leem em vez de conectar ao /mcp.
 *
 * A borda não monta servidor MCP: a superfície mora no CONTAINER. O card é o
 * gerador compartilhado (`@sbissoli/mcp-surface/card`, forma da Smithery:
 * `serverInfo`, `authentication`, listas) perguntando ao container por
 * `fetch` — initialize + as quatro listas, uma vez por isolate —, então nunca
 * diverge do que o /mcp anuncia, e `authentication.required` sai do que a
 * trava MEDIU (`semToken` do surface.lock.json). Se o container não responde
 * (cold start estourou, deploy em curso), o card sai com a lista estática de
 * src/config.ts (só nome e título), na mesma forma, e um campo
 * `source: "static"` dizendo isso, em vez de 500 — sem cachear: quando o
 * container voltar, o card volta com ele.
 */

import { autenticacaoDaTrava, capturarCardPorFetch } from "@sbissoli/mcp-surface/card/http";

// Import nomeado: o esbuild descarta o resto da trava e só a medição `semToken` entra no bundle.
import { semToken } from "../../surface.lock.json";
import { SERVER_CONFIG, TOOLS } from "./config.js";
import { logger } from "./logger.js";

const authentication = autenticacaoDaTrava({ semToken });

/** O card quando o container não responde: mesma forma, ferramentas da lista estática. */
export function staticServerCard(): Record<string, unknown> {
  return {
    serverInfo: { name: SERVER_CONFIG.name, version: SERVER_CONFIG.version, websiteUrl: SERVER_CONFIG.websiteUrl },
    authentication,
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title })),
    source: "static",
  };
}

let cardCache: string | undefined;

/** Card com cache por isolate — só cacheia o que veio do container; o fallback não fica. */
export async function getServerCard(
  containerFetch: (req: Request) => Promise<Response>,
): Promise<string> {
  if (cardCache) return cardCache;
  try {
    const card = await capturarCardPorFetch(containerFetch, `http://container${SERVER_CONFIG.mcpRoute}`, {
      authentication,
    });
    return (cardCache = JSON.stringify(card));
  } catch (err) {
    logger.warn("server_card_fallback", { err: String(err) });
    return JSON.stringify(staticServerCard());
  }
}

/** Zera o cache — somente para testes. */
export function _resetServerCard(): void {
  cardCache = undefined;
}
