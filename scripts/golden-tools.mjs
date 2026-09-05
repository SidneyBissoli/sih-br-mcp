#!/usr/bin/env node
// Golden das doze ferramentas pelo stdio: sobe o servidor compilado em dist/,
// chama CADA ferramenta com um conjunto fixo de argumentos (2–3 casos por
// ferramenta) e grava o que o cliente recebeu. Com `--baseline <arquivo>`,
// compara byte a byte com o gravado antes.
//
//   node scripts/golden-tools.mjs --fixtures tests/fixtures/sih --write    baselines/golden-tools.json
//   node scripts/golden-tools.mjs --fixtures tests/fixtures/sih --baseline baselines/golden-tools.json
//
// POR QUE EXISTE. O smoke (`smoke-stdio.mjs`) prova que a superfície não
// mudou e que três chamadas ainda andam; não prova que os NÚMEROS são os
// mesmos. Este arquivo é a rede para a troca do binding DuckDB (PLAN-002,
// `duckdb` legado 1.4.4 → `@duckdb/node-api`, motor 1.5.5): o golden é gravado
// com o binding antigo e o novo tem de reproduzi-lo. Continua não sendo uma
// suíte — não afirma que os números estão CERTOS, só que não se moveram.
//
// O QUE É GRAVADO. Por caso: `{tool, args, isError, result}`, onde `result` é
// o JSON que o servidor serializa em `content[0].text` (parseado, para o diff
// ser legível) ou o texto cru quando não for JSON. Ordem: a dos casos abaixo,
// que é fixa. O ano consultado vem de `get_available_years`, não de literal.
//
// AO DIVERGIR, qualquer diferença reprova, e o script imprime a PRIMEIRA
// diferença de cada caso classificada como SÓ ORDEM DAS LINHAS ou VALOR. É a
// classificação que a fase 3 do PLAN-002 exige antes de regravar: ordem ou
// representação se ajusta no funil `query()`; valor é o motor falando e pede
// decisão. A ordem das linhas É garantida pelo servidor desde 05/09/2026
// (`buildOrderBy` em src/db/duckdb.ts): a primeira versão deste golden, ainda
// com o binding legado, reprovou contra si mesma em cinco rodadas seguidas —
// GROUP BY sem ORDER BY saía na ordem das threads, ORDER BY por métrica
// empatava sem desempate (`compare_regions` dava posição 5 a GO numa chamada
// e a PB na seguinte), e `limit` em cima disso devolvia SUBCONJUNTOS. Foi
// consertado no funil antes de gravar o golden, com o binding antigo, para a
// troca de binding ter um baseline que se reproduz. Os casos abaixo só usam
// `limit` maior que o conjunto inteiro (10 UFs, 19 grupos): exercitam o
// caminho sem depender de onde o corte cai.
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
if (!writeTo && !baseline) {
  console.error("uso: golden-tools.mjs [--fixtures <dir>] (--write <json> | --baseline <json>)");
  process.exit(2);
}

const fail = (msg) => {
  console.error(`GOLDEN FALHOU: ${msg}`);
  process.exit(1);
};

const client = new Client({ name: "sih-golden", version: "0.0.0" });
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

const call = async (name, toolArgs = {}) => {
  const res = await client.callTool({ name, arguments: toolArgs });
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  return { tool: name, args: toolArgs, isError: res.isError === true, result };
};

// O ano vem do servidor. Y-1 entra em dois casos de tendência para gravar como
// o servidor trata um ano pedido e ausente — hoje a fixture só tem 2023.
const yearsCase = await call("get_available_years");
const yearsText = JSON.stringify(yearsCase.result);
// Lê o campo estrutural `years`; o texto inteiro não serve porque o bloco de
// proveniência traz outros anos (safra, citação) e o regex pegaria o maior.
const years = Array.isArray(yearsCase.result?.years)
  ? yearsCase.result.years.map(Number).filter(Number.isInteger)
  : [...yearsText.matchAll(/(19|20)\d{2}/g)].map((m) => Number(m[0]));
if (years.length === 0) fail("get_available_years não devolveu nenhum ano");
const Y = Math.max(...years);

// Um caso por linha; os valores de UF, grupo CSAP, capítulo CID e município
// são os que existem na fixture (AL AM AP CE GO MA MG PB RJ RR; g01–g19;
// capítulos 1–21; 140010 é o município com mais ICSAP em RR). `limit` só
// aparece maior que o conjunto (10 UFs, 19 grupos) — ver o cabeçalho.
const CASES = [
  ["list_csap_groups", {}],
  ["list_csap_groups", { group_code: "g01", include_cid_codes: true }],
  ["list_cid_chapters", {}],
  ["get_available_years", {}],
  ["classify_as_csap", { cid_codes: ["A09", "I10", "J18", "Z00"] }],
  ["classify_as_csap", { cid_codes: ["E10", "e11", "X99"] }],
  ["get_hospitalizations", { year: [Y] }],
  ["get_hospitalizations", { year: [Y], group_by: ["uf"], limit: 50 }],
  ["get_hospitalizations", { year: [Y], uf: ["MG", "RJ"], sex: "F", age_min: 0, age_max: 14, group_by: ["cid_chapter"] }],
  ["get_hospitalizations", { year: [Y], is_csap: true, group_by: ["year", "csap_group"] }],
  ["get_hospitalization_trends", { year_start: Y - 1, year_end: Y, granularity: "yearly" }],
  ["get_hospitalization_trends", { year_start: Y, year_end: Y, granularity: "monthly", uf: ["MG"] }],
  ["get_hospitalization_trends", { year_start: Y, year_end: Y, granularity: "monthly", cid_chapter: 10 }],
  ["compare_regions", { year: [Y], compare_by: "uf", limit: 50 }],
  ["compare_regions", { year: [Y], compare_by: "region", metric: "deaths", is_csap: true }],
  ["compare_regions", { year: [Y], compare_by: "uf", cid_chapter: 9, metric: "n" }],
  ["get_icsap", { year: [Y] }],
  ["get_icsap", { year: [Y], group_by: ["csap_group"] }],
  ["get_icsap", { year: [Y], municipality_code: "140010", group_by: ["sex"] }],
  ["get_icsap", { year: [Y], uf: ["CE", "MA"], csap_group: ["g01", "g02"], age_min: 60, group_by: ["uf", "race"] }],
  ["get_icsap_indicators", { year: [Y] }],
  ["get_icsap_indicators", { year: [Y], group_by: ["uf"] }],
  ["get_icsap_indicators", { year: [Y], uf: ["RR"], sex: "M", group_by: ["sex"] }],
  ["rank_csap_groups", { year: [Y], limit: 50 }],
  ["rank_csap_groups", { year: [Y], metric: "deaths", uf: ["MG"] }],
  ["rank_csap_groups", { year: [Y], metric: "value", sex: "F", age_min: 0, age_max: 4 }],
  ["get_hospitalization_rates", { year: [Y] }],
  ["get_hospitalization_rates", { year: [Y], rate_type: "specific", rate_per: 100000, group_by: ["uf"] }],
  ["get_hospitalization_rates", { year: [Y], sex: "M", age_min: 60, is_csap: true, group_by: ["sex"] }],
  ["compare_icsap_trends", { start_year: Y - 1, end_year: Y, compare_by: "uf", compare_values: ["MG", "RJ"], indicator: "percentage" }],
  ["compare_icsap_trends", { start_year: Y, end_year: Y, compare_by: "csap_group", compare_values: ["g01", "g02"], indicator: "rate_per_10k" }],
  ["compare_icsap_trends", { start_year: Y, end_year: Y, compare_by: "uf", indicator: "count", include_trend_line: false }],
];

// Toda ferramenta do tools/list tem de ter pelo menos um caso: uma ferramenta
// nova sem golden é exatamente o buraco que este arquivo existe para fechar.
const covered = new Set(CASES.map(([t]) => t));
const semCaso = tools.map((t) => t.name).filter((n) => !covered.has(n));
if (semCaso.length) fail(`ferramentas do tools/list sem caso no golden: ${semCaso.join(", ")}`);
const inexistente = [...covered].filter((n) => !tools.some((t) => t.name === n));
if (inexistente.length) fail(`casos para ferramentas que não existem: ${inexistente.join(", ")}`);

const golden = [];
for (const [tool, toolArgs] of CASES) {
  const r = await call(tool, toolArgs);
  golden.push(r);
  console.log(`${tool}(${JSON.stringify(toolArgs)}): ${r.isError ? "isError" : "ok"}`);
}
await client.close();
const goldenJson = JSON.stringify(golden, null, 2) + "\n";
console.log(`${golden.length} casos em ${covered.size} ferramentas (ano consultado: ${Y})`);

// --- comparação -------------------------------------------------------------

// Forma canônica que ignora a ORDEM dos elementos de qualquer array: serve para
// dizer se uma divergência é só de ordem das linhas (motor) ou de valor.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon).sort();
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
};
const sameIgnoringOrder = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// Primeiro caminho (chave a chave) em que dois valores diferem.
const firstDiff = (a, b, path = "$") => {
  if (a === b) return null;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) return `${path}: tipo ${ta} → ${tb}`;
  if (ta === "array") {
    if (a.length !== b.length) return `${path}: ${a.length} → ${b.length} elementos`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (!(k in a)) return `${path}.${k}: chave nova`;
      if (!(k in b)) return `${path}.${k}: chave sumiu`;
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`;
};

if (baseline) {
  const expectedJson = readFileSync(baseline, "utf8");
  if (expectedJson !== goldenJson) {
    const expected = JSON.parse(expectedJson);
    const valor = [];
    const ordem = [];
    const n = Math.max(expected.length, golden.length);
    for (let i = 0; i < n; i++) {
      const e = expected[i];
      const g = golden[i];
      if (!e || !g || e.tool !== g.tool || JSON.stringify(e.args) !== JSON.stringify(g.args)) {
        valor.push(`caso ${i}: ${e ? `${e.tool} ${JSON.stringify(e.args)}` : "(ausente)"} → ${g ? `${g.tool} ${JSON.stringify(g.args)}` : "(ausente)"}`);
        continue;
      }
      const d = firstDiff(e, g);
      if (!d) continue;
      (sameIgnoringOrder(e, g) ? ordem : valor).push(`${e.tool} ${JSON.stringify(e.args)}\n    ${d}`);
    }
    fail(
      `resultado difere do baseline ${baseline} em ${valor.length + ordem.length} caso(s):` +
        (valor.length ? `\n  VALOR (${valor.length}):\n  ` + valor.join("\n  ") : "") +
        (ordem.length ? `\n  SÓ ORDEM DAS LINHAS (${ordem.length}):\n  ` + ordem.join("\n  ") : ""),
    );
  }
  console.log(`golden == ${baseline}`);
}
if (writeTo) {
  mkdirSync(dirname(writeTo), { recursive: true });
  writeFileSync(writeTo, goldenJson);
  console.log(`golden gravado em ${writeTo}`);
}
