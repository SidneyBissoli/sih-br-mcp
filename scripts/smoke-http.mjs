#!/usr/bin/env node
// Smoke do transporte Streamable HTTP (PLAN-004): sobe dist/http.js numa porta
// local, espera o /healthz, e pelo cliente do SDK v2 lista as ferramentas e
// faz as MESMAS três chamadas do smoke stdio, contra o MESMO baseline de
// superfície. É a prova de que o transporte troca sem tocar nas ferramentas.
//
//   node scripts/smoke-http.mjs --fixtures tests/fixtures/sih --baseline baselines/surface-stdio.json
//
// Sem rede: SIH_CUBES_CACHE=off e SIH_FRESHNESS_CHECK=off, como no stdio.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { checkAnnotations, checkSurface, surfaceOf, threeCalls } from "./lib/smoke-checks.mjs";

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const baseline = opt("--baseline");
const fixtures = opt("--fixtures");
const port = Number(opt("--port") ?? 20000 + Math.floor(Math.random() * 20000));

const fail = (msg) => {
  console.error(`SMOKE HTTP FALHOU: ${msg}`);
  process.exit(1);
};

const child = spawn(process.execPath, [resolve("dist/http.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    SIH_HTTP_HOST: "127.0.0.1",
    SIH_FRESHNESS_CHECK: "off",
    SIH_CUBES_CACHE: "off",
    ...(fixtures ? { SIH_DATA_DIR: resolve(fixtures) } : {}),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });
const stop = () => { if (!child.killed) child.kill(); };
process.on("exit", stop);

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 20_000;
let health = null;
while (Date.now() < deadline && !health) {
  try {
    const r = await fetch(`${base}/healthz`);
    if (r.ok) health = await r.json();
  } catch { /* ainda subindo */ }
  if (!health) await new Promise((r) => setTimeout(r, 200));
}
if (!health) fail(`/healthz não respondeu em 20 s\n${stderr}`);
console.log(`/healthz: ${health.server} ${health.version}, anos em cache: ${health.cached_years.join(", ") || "nenhum"}`);

const client = new Client({ name: "sih-smoke-http", version: "0.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const { tools } = await client.listTools();
  console.log(`tools/list: ${tools.length} ferramentas`);
  checkSurface(surfaceOf(tools), { baseline });
  checkAnnotations(tools);
  const year = await threeCalls(client);
  await client.close();

  // Sonda CRUA, fora do cliente do SDK (que nunca manda cursor): cursor de
  // paginação inválido tem de virar -32602 no corpo com HTTP 200 — o guarda
  // de src/pagination.ts na borda do contêiner. Regra
  // `pagination_tools_invalid_cursor` do mcpscore; é medida aqui porque o
  // Worker não participa deste smoke e a recusa tem de existir sem ele.
  const sonda = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", params: { cursor: "nao-existe" } }),
  });
  const recusa = await sonda.json().catch(() => undefined);
  if (sonda.status !== 200 || recusa?.error?.code !== -32602 || recusa?.id !== 91) {
    fail(`cursor inválido não virou -32602: HTTP ${sonda.status} ${JSON.stringify(recusa)?.slice(0, 200)}`);
  }
  console.log("tools/list com cursor inválido: -32602");

  console.log(`SMOKE HTTP OK (ano consultado: ${year}, porta ${port})`);
} catch (e) {
  fail(`${e?.message ?? e}\n--- stderr do servidor ---\n${stderr}`);
} finally {
  stop();
}
