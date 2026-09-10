#!/usr/bin/env node
// Equivalência do roteamento para o cubo LEVE (0.14.2, decisão 33).
//
// `compare_regions` e `get_hospitalization_rates` passam a ler o cubo de
// séries (1,2 MB nos 34 anos) quando o recorte cabe nele, em vez do de causas
// (1.253 MB). Esta prova exige que a resposta seja IDÊNTICA à do caminho
// antigo, byte a byte, nos cenários que roteiam — e que os cenários finos
// (sexo, idade, sensíveis) continuem no caminho antigo.
//
// Uso: node scripts/series-routing-equivalence.mjs --fixtures tests/fixtures/sih
import { resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : [])).filter((p) => p.length),
);
process.env.SIH_DATA_DIR = resolve(String(args.fixtures ?? "tests/fixtures/sih"));
process.env.SIH_CUBES_CACHE = "off";

const { queryCausas, querySeriesYearly } = await import("../dist/db/duckdb.js");
const J = (v) => JSON.stringify(v);
let fails = 0;

// Os dois caminhos, lado a lado, no MESMO recorte. Espelha o que os handlers
// montam (compare_regions: groupBy uf + orderBy por métrica + limit; taxas:
// groupBy variável, sem orderBy).
const cenarios = [
  { nome: "compare_regions por uf, ordenado por n", years: [2023], groupBy: ["uf"], orderBy: "n_hospitalizations DESC", limit: 50 },
  { nome: "compare_regions por uf, ordenado por óbitos", years: [2023], groupBy: ["uf"], orderBy: "deaths DESC", limit: 10 },
  { nome: "compare_regions com capítulo CID", years: [2023], cidChapters: [9], groupBy: ["uf"], orderBy: "n_hospitalizations DESC", limit: 50 },
  { nome: "taxas sem recorte (grupo vazio)", years: [2023], groupBy: [] },
  { nome: "taxas por uf", years: [2023], groupBy: ["uf"] },
  { nome: "taxas por ano e uf", years: [2023], groupBy: ["year", "uf"] },
  { nome: "taxas de uma uf só", years: [2023], ufs: ["MG"], groupBy: ["uf"] },
  { nome: "por capítulo e revisão", years: [2023], groupBy: ["cid_revision", "cid_chapter"], limit: 50 },
];

for (const c of cenarios) {
  const causas = await queryCausas({
    filters: { years: c.years, ufs: c.ufs, cidChapters: c.cidChapters },
    groupBy: c.groupBy,
    metrics: ["n", "deaths"],
    orderBy: c.orderBy,
    limit: c.limit,
  });
  const series = await querySeriesYearly({
    years: c.years,
    ufs: c.ufs,
    cidChapters: c.cidChapters,
    groupBy: c.groupBy,
    orderBy: c.orderBy,
    limit: c.limit,
  });
  const igual = J(causas) === J(series);
  if (!igual) {
    fails++;
    console.error(`DIVERGE: ${c.nome}\n  causas: ${J(causas).slice(0, 260)}\n  series: ${J(series).slice(0, 260)}`);
  } else {
    console.error(`igual: ${c.nome} (${causas.length} linhas)`);
  }
}

// O roteador precisa RECUSAR o que o cubo leve não representa.
const { __seriesFitsCallForTests } = await import("../dist/tools.js");
if (typeof __seriesFitsCallForTests === "function") {
  const casos = [
    ["compare_regions", { year: [2023], compare_by: "uf" }, true],
    ["compare_regions", { year: [2023], compare_by: "uf", is_csap: true }, false],
    ["get_hospitalization_rates", { year: [2023] }, true],
    ["get_hospitalization_rates", { year: [2023], group_by: ["uf"] }, true],
    ["get_hospitalization_rates", { year: [2023], sex: "M" }, false],
    ["get_hospitalization_rates", { year: [2023], age_min: 60 }, false],
    ["get_hospitalization_rates", { year: [2023], group_by: ["sex"] }, false],
    ["get_hospitalizations", { year: [2023] }, false],
    ["get_icsap", { year: [2023] }, false],
  ];
  for (const [tool, a, esperado] of casos) {
    const got = __seriesFitsCallForTests(tool, a);
    if (got !== esperado) {
      fails++;
      console.error(`ROTA ERRADA: ${tool} ${J(a)} → ${got}, esperado ${esperado}`);
    } else {
      console.error(`rota ok: ${tool} ${J(a)} → ${got ? "series" : "cubo pesado"}`);
    }
  }
} else {
  fails++;
  console.error("ROTA: __seriesFitsCallForTests não exportado");
}

if (fails) {
  console.error(`series-routing-equivalence: ${fails} falha(s)`);
  process.exit(1);
}
console.error(`SERIES-ROUTING OK (${cenarios.length} cenários idênticos + roteamento conferido)`);
