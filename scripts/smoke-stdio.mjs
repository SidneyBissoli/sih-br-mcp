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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

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
  env: fixtures
    ? { ...getDefaultEnvironment(), SIH_DATA_DIR: resolve(fixtures) }
    : undefined,
  stderr: "pipe",
});
let tools;
try {
  await client.connect(transport);
  ({ tools } = await client.listTools());
} catch (e) {
  fail(`servidor não subiu ou não respondeu ao tools/list: ${e?.message ?? e}`);
}
if (!Array.isArray(tools) || tools.length === 0) fail("tools/list vazio");
for (const t of tools) {
  if (!t.inputSchema || t.inputSchema.type !== "object")
    fail(`ferramenta ${t.name} sem inputSchema de objeto`);
}
const surface = [...tools]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const surfaceJson = JSON.stringify(surface, null, 2) + "\n";
console.log(`tools/list: ${tools.length} ferramentas`);

if (baseline) {
  const expected = readFileSync(baseline, "utf8");
  if (expected !== surfaceJson) {
    const before = new Set(JSON.parse(expected).map((t) => t.name));
    const after = new Set(surface.map((t) => t.name));
    const gone = [...before].filter((n) => !after.has(n));
    const novo = [...after].filter((n) => !before.has(n));
    fail(
      `superfície difere do baseline ${baseline}` +
        (gone.length ? ` | sumiram: ${gone.join(", ")}` : "") +
        (novo.length ? ` | novas: ${novo.join(", ")}` : "") +
        (!gone.length && !novo.length ? " | mesmos nomes, descrição ou schema mudou" : ""),
    );
  }
  console.log(`superfície == ${baseline}`);
}
if (writeTo) {
  mkdirSync(dirname(writeTo), { recursive: true });
  writeFileSync(writeTo, surfaceJson);
  console.log(`superfície gravada em ${writeTo}`);
}

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) fail(`${name} devolveu isError: ${JSON.stringify(res.content).slice(0, 300)}`);
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (!text.trim()) fail(`${name} devolveu conteúdo vazio`);
  console.log(`${name}: ok (${text.length} chars)`);
  return text;
};

const csap = await call("list_csap_groups");
if (!/g01/i.test(csap)) fail("list_csap_groups não menciona g01");

const yearsText = await call("get_available_years");
// Lê o campo estrutural `years`; o texto inteiro não serve porque o bloco de
// proveniência traz outros anos (safra, citação) e o regex pegaria o maior.
let yearsJson = null;
try { yearsJson = JSON.parse(yearsText); } catch { /* texto não JSON: cai no regex */ }
const years = Array.isArray(yearsJson?.years)
  ? yearsJson.years.map(Number).filter(Number.isInteger)
  : [...yearsText.matchAll(/(19|20)\d{2}/g)].map((m) => Number(m[0]));
if (years.length === 0) fail("get_available_years não devolveu nenhum ano");
const year = Math.max(...years);

const rank = await call("rank_csap_groups", { year: [year], limit: 3 });
if (!/g\d{2}/i.test(rank)) fail(`rank_csap_groups(${year}) não devolveu grupo nenhum`);

await client.close();
console.log(`SMOKE OK (ano consultado: ${year})`);
