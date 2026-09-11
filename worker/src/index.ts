/**
 * Entrypoint do Worker de borda — instância do template de hosting da Fase 0
 * com UMA diferença: o /mcp não roda no isolate, é encaminhado ao Cloudflare
 * Container que executa dist/http.js (DuckDB nativo não roda em Workers).
 *
 * Fluxo por request: rotas públicas (landing, descoberta, /health, /status,
 * /metrics, server card, glama) → Host/Origin do /mcp (403) → Bearer auth
 * opcional → rate limit por cliente → proxy ao container, com telemetria por
 * chamada no Analytics Engine e no UsageTracker.
 */

import { getContainer } from "@cloudflare/containers";

import { SELF_ROUTE, tagRequest, withAnalytics } from "./analytics.js";
import { checkAuth } from "./auth.js";
import { getServerCard } from "./card.js";
import { CONTAINER_INSTANCE, HEALTH_PROBE_TIMEOUT_MS, SERVER_CONFIG } from "./config.js";
import { SihContainer, type ContainerProbe } from "./container.js";
import { discoveryResponseForPath } from "./discovery.js";
import { landingResponse } from "./landing.js";
import { logger } from "./logger.js";
import {
  corsHeaders,
  forwardedHeaders,
  isAllowedHost,
  isAllowedOrigin,
  toolNamesFromBody,
} from "./mcp-proxy.js";
import { checkRateLimit } from "./rate-limit.js";
import { buildStatus } from "./status.js";
import type { Env } from "./types.js";
import { createUsageRecorder, usageSnapshot, UsageTracker } from "./usage.js";

// O runtime instancia os Durable Objects a partir dos exports do entrypoint.
export { SihContainer, UsageTracker };

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function text(body: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", ...extraHeaders } });
}

/** Stub do container único, ou undefined sem o binding (dev/testes). */
function sihStub(env: Env) {
  return env.SIH ? getContainer(env.SIH, CONTAINER_INSTANCE) : undefined;
}

/** Sonda o container para GET /health sem acordá-lo; nunca lança. */
async function probeContainer(env: Env): Promise<ContainerProbe | { container: "unbound" }> {
  const stub = sihStub(env);
  if (!stub) return { container: "unbound" };
  try {
    return await stub.probe(HEALTH_PROBE_TIMEOUT_MS);
  } catch (e) {
    return { container: "down", error: String(e) };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();
    const record = createUsageRecorder(env, ctx);

    // --- Rotas públicas, servidas antes de qualquer auth ---
    if (url.pathname === "/") return landingResponse();
    // robots.txt, sitemap.xml e a chave do IndexNow vêm ANTES da auth: um
    // rastreador não tem credencial, e robots.txt atrás de Bearer é o mesmo que
    // não ter robots.txt.
    const descoberta = discoveryResponseForPath(url.pathname);
    if (descoberta) return descoberta;
    if (url.pathname === "/health") {
      // O Worker está de pé (200 sempre); o container é relatado, não exigido:
      // "asleep" é o estado normal fora do horário de uso e não é falha.
      const sonda = await probeContainer(env);
      return json({ status: "ok", ...sonda }, 200, { "Cache-Control": "no-store" });
    }
    if (url.pathname === "/status") {
      return json(buildStatus(env), 200, { "Cache-Control": "no-store" });
    }
    if (url.pathname === "/metrics") {
      const snap = await usageSnapshot(env);
      return json(snap ?? { aviso: "binding USAGE ausente — estatísticas de uso desativadas" });
    }

    // MCP server card para scanners de registry que o leem em vez do /mcp.
    if (url.pathname === "/.well-known/mcp/server-card.json") {
      const stub = sihStub(env);
      const card = await getServerCard(
        stub ? (req) => stub.fetch(req) : () => Promise.reject(new Error("binding SIH ausente")),
      );
      return new Response(card, { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Descritor de conector do Glama (descoberta de registry).
    if (url.pathname === "/.well-known/glama.json") {
      return json({
        $schema: "https://glama.ai/mcp/schemas/connector.json",
        maintainers: [{ email: SERVER_CONFIG.contactEmail }],
      });
    }

    // A rota privada do dono (SELF_ROUTE) serve EXATAMENTE a mesma coisa; o
    // que muda e o registro — tagRequest marca self por ela, ver
    // src/analytics.ts. O container continua recebendo /mcp: a separacao e
    // assunto da borda, e ele nao precisa saber que a rota existe.
    if (url.pathname !== SERVER_CONFIG.mcpRoute && url.pathname !== SELF_ROUTE) {
      return text("Not Found", 404);
    }

    // --- /mcp: Host e Origin ANTES de auth e rate limit (spec 2025-11-25) ---
    const origin = request.headers.get("Origin");
    if (!isAllowedHost(request.headers.get("Host"))) {
      logger.warn("host_rejected", { host: request.headers.get("Host") });
      return text("Forbidden: invalid Host header", 403);
    }
    if (!isAllowedOrigin(origin, request.headers.get("Host"), env.ALLOWED_ORIGIN)) {
      logger.warn("origin_rejected", { origin });
      return text("Forbidden: invalid Origin header", 403);
    }
    const cors = corsHeaders(origin);

    // Preflight CORS nunca carrega Authorization — respondido na borda, sem
    // acordar o container (o transporte do SDK não trata OPTIONS).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!["POST", "GET", "DELETE"].includes(request.method)) {
      return text("Method Not Allowed", 405, { Allow: "GET, POST, DELETE, OPTIONS", ...cors });
    }

    const authResponse = await checkAuth(request, env.API_KEY);
    if (authResponse) {
      record("auth_failure", url.pathname);
      logger.warn("auth_failure", { method: request.method, path: url.pathname, status: authResponse.status });
      return authResponse;
    }

    const clientId = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const decision = checkRateLimit(clientId);
    if (!decision.allowed) {
      record("rate_limited", url.pathname);
      return text("Too Many Requests", 429, { "Retry-After": String(decision.retryAfterS), ...cors });
    }

    record("request", url.pathname);

    const stub = sihStub(env);
    if (!stub) {
      return json({ jsonrpc: "2.0", error: { code: -32603, message: "container binding unavailable" }, id: null }, 503, cors);
    }

    // Nome(s) a registrar na telemetria: lidos de uma CÓPIA do corpo, antes de
    // o stream original seguir para o container. Só o POST carrega JSON-RPC.
    const nomes =
      request.method === "POST"
        ? toolNamesFromBody(await request.clone().json().catch(() => undefined))
        : [];

    // Corpo em STREAM, sem bufferizar: a resposta é SSE e a série de 34 anos
    // leva ~30 s. Cabeçalhos por lista positiva (src/mcp-proxy.ts); o Host que
    // o container vê é o dele. `stub.fetch` acorda o container se preciso e
    // renova o relógio do sleepAfter.
    const alvo = new Request(`http://container${SERVER_CONFIG.mcpRoute}${url.search}`, {
      method: request.method,
      headers: forwardedHeaders(request.headers),
      body: request.method === "POST" ? request.body : null,
    });

    let upstream: Response;
    try {
      upstream = await stub.fetch(alvo);
    } catch (e) {
      logger.error("container_fetch_failed", { err: String(e) });
      upstream = json(
        { jsonrpc: "2.0", error: { code: -32603, message: "container unavailable" }, id: null },
        502,
      );
    }

    // Telemetria por chamada (Analytics Engine + UsageTracker): status "ok" se o
    // HTTP do container for < 400, senão "error". O par tool_call/tool_error é
    // síncrono — é o que withAnalytics coalesce numa linha só. Ver a LIMITAÇÃO
    // em toolNamesFromBody: erro JSON-RPC dentro do SSE não é lido.
    const recordWithAnalytics = withAnalytics(record, env.ANALYTICS, tagRequest(request, env.SELF_MARKER));
    for (const nome of nomes) {
      recordWithAnalytics("tool_call", nome);
      if (upstream.status >= 400) recordWithAnalytics("tool_error", nome);
    }

    // Repassa o corpo como stream (new Response(body) não consome) e acrescenta
    // o CORS resolvido na borda.
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });

    logger.info("request", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      tools: nomes,
      ms: Date.now() - start,
    });
    return response;
  },
} satisfies ExportedHandler<Env>;
