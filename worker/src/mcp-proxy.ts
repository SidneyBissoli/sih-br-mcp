/**
 * Núcleo puro do proxy /mcp → container — sem nenhuma API do Workers, para que
 * as decisões (Host, Origin, CORS, qual tool registrar na telemetria) sejam
 * testáveis em Node. O encaminhamento em si fica em src/index.ts.
 *
 * POR QUE O WORKER VALIDA HOST E ORIGIN. A spec do MCP (Streamable HTTP,
 * 2025-11-25) manda o servidor validar o header Origin em toda conexão e
 * responder 403 quando inválido, contra DNS rebinding. As opções
 * allowedHosts/allowedOrigins do SDK estão deprecated em favor de middleware
 * externo, e o container (../src/http.ts) deliberadamente não valida nada —
 * este Worker é o único que fala com ele. Requisição SEM Origin passa: é o
 * caso dos clientes de servidor (conector do claude.ai, Claude Code, Inspector
 * em modo CLI), que não são navegador e não têm de onde vir.
 */

import { SERVER_CONFIG } from "./config.js";

/** Hostname sem porta e em minúsculas, ou "" se o header não parseia. */
export function hostnameOf(hostHeader: string | null): string {
  if (!hostHeader) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Host aceito? Compara o hostname (sem porta) com SERVER_CONFIG.allowedHostnames. */
export function isAllowedHost(hostHeader: string | null): boolean {
  const host = hostnameOf(hostHeader);
  return host !== "" && SERVER_CONFIG.allowedHostnames.includes(host);
}

/**
 * Origin aceita? Regras, na ordem:
 *  1. sem Origin → aceita (cliente que não é navegador);
 *  2. `allowedOriginVar` = "*" → aceita qualquer;
 *  3. Origin cujo hostname é o próprio host da requisição, um dos
 *     allowedHostnames ou localhost/127.0.0.1 (qualquer porta) → aceita;
 *  4. Origin listada em `allowedOriginVar` (vírgula) → aceita;
 *  5. resto → recusa (403 no index.ts).
 * Origin "null" (arquivo local, sandbox) cai na regra 5.
 */
export function isAllowedOrigin(
  origin: string | null,
  hostHeader: string | null,
  allowedOriginVar: string | undefined,
): boolean {
  if (origin === null || origin === "") return true;
  const lista = (allowedOriginVar ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lista.includes("*")) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;
  if (originHost === hostnameOf(hostHeader)) return true;
  if (SERVER_CONFIG.allowedHostnames.includes(originHost)) return true;
  if (originHost === "localhost" || originHost === "127.0.0.1") return true;
  return lista.some((o) => o.replace(/\/$/, "").toLowerCase() === origin.toLowerCase());
}

/**
 * Cabeçalhos CORS da resposta do /mcp. Só ecoa a Origin quando ela foi
 * validada (a chamada acontece depois de isAllowedOrigin) — nunca "*" com
 * credenciais. Sem Origin, nenhum cabeçalho CORS é preciso.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Cabeçalhos que seguem do cliente para o container. Lista POSITIVA: o que o
 * transporte Streamable HTTP lê (Accept, Content-Type, sessão, versão do
 * protocolo, Last-Event-ID) mais Content-Length. Authorization, Cookie, o
 * marcador self e os cabeçalhos CF-* ficam na borda — o container não os usa
 * e não deve vê-los.
 */
export const FORWARDED_HEADERS = [
  "accept",
  "content-type",
  "content-length",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

export function forwardedHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const nome of FORWARDED_HEADERS) {
    const v = incoming.get(nome);
    if (v !== null) out.set(nome, v);
  }
  return out;
}

/**
 * Qual nome registrar na telemetria para um POST /mcp, a partir do corpo
 * JSON-RPC (já parseado, ou undefined se não era JSON):
 *  - `tools/call` → `params.name` (a tool de verdade — é o que o painel agrupa);
 *  - outro método → o próprio método (`initialize`, `tools/list`, ...);
 *  - lote JSON-RPC (array) → um nome por item;
 *  - notificação/resposta sem `method` ou corpo inválido → nada.
 *
 * LIMITAÇÃO: o desfecho registrado é o HTTP do container (< 400 = "ok"). Um
 * erro JSON-RPC ou `isError: true` que viaja DENTRO do SSE com HTTP 200 não é
 * lido — ler exigiria consumir o stream que está sendo repassado ao cliente.
 * O painel verá esses casos como "ok"; o UsageTracker também.
 */
export function toolNamesFromBody(body: unknown): string[] {
  const itens = Array.isArray(body) ? body : [body];
  const nomes: string[] = [];
  for (const item of itens) {
    if (!item || typeof item !== "object") continue;
    const msg = item as { method?: unknown; params?: unknown };
    if (typeof msg.method !== "string" || msg.method === "") continue;
    if (msg.method === "tools/call") {
      const params = msg.params as { name?: unknown } | undefined;
      if (typeof params?.name === "string" && params.name !== "") nomes.push(params.name);
      else nomes.push("tools/call");
    } else {
      nomes.push(msg.method);
    }
  }
  return nomes;
}
