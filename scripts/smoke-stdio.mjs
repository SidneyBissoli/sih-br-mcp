#!/usr/bin/env node
// Smoke do transporte stdio: sobe o servidor compilado em dist/, lista as
// ferramentas e chama três delas de ponta a ponta (metadados, anos, ranking).
//
// Não pina contagem nem nome de ferramenta: a superfície (nome + descrição +
// inputSchema, ordenada por nome) é DERIVADA do tools/list e, quando se passa
// `--baseline <arquivo>`, comparada byte a byte com a gravada antes. É assim que
// um bump de dependência prova que não mexeu no que o cliente vê.
//
//   node scripts/smoke-stdio.mjs --fixtures tests/fixtures/sih --write    baselines/surface-stdio.json
//   node scripts/smoke-stdio.mjs --fixtures tests/fixtures/sih --baseline baselines/surface-stdio.json
//
// `--fixtures <dir>` aponta o servidor (via SIH_DATA_DIR) para os cubos
// versionados em tests/fixtures/sih — data/*.parquet é gitignored e o CI parte
// de um checkout sem dado nenhum; foi assim que a 1ª rodada do smoke no CI
// reprovou em 04/09/2026. Sem a flag, o servidor lê data/ como sempre.
// O ano consultado vem de `get_available_years`, não de literal.
//
// As verificações (superfície, anotações, três chamadas) vivem em
// lib/smoke-checks.mjs, compartilhadas com smoke-http.mjs (PLAN-004): os dois
// transportes são medidos pela mesma régua.
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { checkAnnotations, checkSurface, surfaceOf, threeCalls } from "./lib/smoke-checks.mjs";

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const writeTo = opt("--write");
const baseline = opt("--baseline");
const fixtures = opt("--fixtures");

const fail = (msg) => {
  console.error(`SMOKE FALHOU: ${msg}`);
  process.exit(1);
};

const client = new Client({ name: "sih-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  // SIH_FRESHNESS_CHECK=off: o servidor NÃO sonda o manifesto do espelho
  // healthbr-data (src/freshness.ts) — a resposta ficaria refém da rede e o
  // baseline deixaria de ser byte a byte. A comparação em si é coberta offline
  // por scripts/freshness-check.mjs --selftest.
  env: {
    ...getDefaultEnvironment(),
    SIH_FRESHNESS_CHECK: "off",
    // SIH_CUBES_CACHE=off: nem manifesto nem download do canal público — a
    // fixture é a única fonte; o smoke não pode depender de rede.
    SIH_CUBES_CACHE: "off",
    ...(fixtures ? { SIH_DATA_DIR: resolve(fixtures) } : {}),
  },
  stderr: "pipe",
});
let tools;
try {
  await client.connect(transport);
  ({ tools } = await client.listTools());
} catch (e) {
  fail(`servidor não subiu ou não respondeu ao tools/list: ${e?.message ?? e}`);
}
try {
  console.log(`tools/list: ${tools.length} ferramentas`);
  checkSurface(surfaceOf(tools), { baseline, writeTo });
  checkAnnotations(tools);
  const year = await threeCalls(client);
  await client.close();
  console.log(`SMOKE OK (ano consultado: ${year})`);
} catch (e) {
  fail(e?.message ?? String(e));
}
