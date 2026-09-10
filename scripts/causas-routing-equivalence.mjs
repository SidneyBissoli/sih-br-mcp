#!/usr/bin/env node
// Equivalência dos PRÉ-AGREGADOS do cubo de CAUSAS (PLAN-006): o grão A
// (resumo, 569 KB nos 34 anos) e o grão B (estratos, ~0,55 MB/ano) têm de
// devolver EXATAMENTE o que o cubo devolve — byte a byte no JSON — em cada
// recorte que roteia, e o roteador tem de RECUSAR o que não cabe.
//
// Deriva os dois grãos AQUI, dos mesmos cubos da pasta de dados. O SQL
// canônico é o do produtor (healthbr-data
// scripts/pipeline/sih-cubos/derive-causas-summary.mjs); esta cópia serve à
// prova e denuncia divergência de desenho se o produtor mudar.
//
// Uso:
//   node scripts/causas-routing-equivalence.mjs --fixtures tests/fixtures/sih   (CI)
//   node scripts/causas-routing-equivalence.mjs --fixtures <pasta com 34 anos>
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : [])).filter((p) => p.length),
);
const dataDir = resolve(String(args.fixtures ?? "tests/fixtures/sih"));
process.env.SIH_DATA_DIR = dataDir;
process.env.SIH_CUBES_CACHE = "off";

const { DuckDBInstance } = await import("@duckdb/node-api");
const { queryCausas, lastCausasQueryPath } = await import("../dist/db/duckdb.js");
const { setCausasSummaryStateForTests } = await import("../dist/cache.js");

const posix = (p) => p.replace(/\\/g, "/");
const J = (v) => JSON.stringify(v);

function fail(msg) {
  console.error(`causas-routing-equivalence: ${msg}`);
  process.exit(1);
}

// --- deriva grão A + grão B dos cubos da pasta (mesmo SQL do produtor) ------
const years = readdirSync(dataDir)
  .map((f) => f.match(/^sih_causas_(\d{4})\.parquet$/)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((a, b) => a - b);
if (years.length === 0) fail(`nenhum cubo de causas em ${dataDir}`);

const GRAO_A = ["year", "uf", "cid_chapter", "cid_revision", "is_csap", "exclusion"];
const GRAO_B = [...GRAO_A, "sex", "age_group", "race"];
const AGE_GROUP = `CASE
      WHEN age IS NULL OR age < 0 THEN NULL
      WHEN age >= 80 THEN '80 e +'
      ELSE CAST(CAST(floor(age / 5.0) * 5 AS INTEGER) AS VARCHAR) || '-' || CAST(CAST(floor(age / 5.0) * 5 + 4 AS INTEGER) AS VARCHAR)
    END AS age_group`;
const MEASURES = "SUM(n) AS n, SUM(days) AS days, SUM(CAST(value AS DECIMAL(18,2))) AS value, SUM(deaths) AS deaths";

const tmp = mkdtempSync(join(tmpdir(), "sih-causas-equiv-"));
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const estratosPaths = new Map();
for (const y of years) {
  const out = join(tmp, `sih_causas_estratos_${y}.parquet`);
  const keys = GRAO_B.map((k) => (k === "cid_revision" ? "COALESCE(cid_revision, 10) AS cid_revision" : k === "age_group" ? AGE_GROUP : k));
  const groupKeys = GRAO_B.map((k) => (k === "cid_revision" ? "COALESCE(cid_revision, 10)" : k));
  await conn.run(`COPY (
    SELECT ${keys.join(", ")}, ${MEASURES}
    FROM read_parquet('${posix(join(dataDir, `sih_causas_${y}.parquet`))}')
    GROUP BY ${groupKeys.join(", ")}
    ORDER BY ${GRAO_B.join(", ")}
  ) TO '${posix(out)}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  estratosPaths.set(y, out);
}
const resumoPath = join(tmp, "sih_causas_resumo.parquet");
await conn.run(`COPY (
  SELECT ${GRAO_A.join(", ")}, SUM(n) AS n, SUM(days) AS days, SUM(value) AS value, SUM(deaths) AS deaths
  FROM read_parquet('${posix(join(tmp, "sih_causas_estratos_*.parquet"))}', union_by_name = true)
  GROUP BY ${GRAO_A.join(", ")}
  ORDER BY ${GRAO_A.join(", ")}
) TO '${posix(resumoPath)}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
conn.closeSync?.();
inst.closeSync?.();

const state = { resumoPath, freshYears: new Set(years), estratosPaths };

// --- cenários --------------------------------------------------------------
const yN = years[years.length - 1];
const y0 = years[0];
const span = years.slice(-Math.min(3, years.length));
const M4 = ["n", "days", "value", "deaths"];

const scenarios = [
  // Grão A: as perguntas que motivaram o plano.
  { name: "internações e gasto por ano (grão A)", route: "resumo", o: { filters: { years }, groupBy: ["year"], metrics: M4, orderBy: "year" } },
  { name: "totais sem agrupamento (grão A)", route: "resumo", o: { filters: { years: span }, metrics: M4 } },
  { name: "por uf com limit por n (grão A)", route: "resumo", o: { filters: { years: span }, groupBy: ["uf"], metrics: M4, orderBy: "n_hospitalizations DESC", limit: 10 } },
  { name: "principais capítulos CID (grão A)", route: "resumo", o: { filters: { years: [yN] }, groupBy: ["cid_chapter"], metrics: M4, orderBy: "n_hospitalizations DESC", limit: 20 } },
  { name: "só CSAP, por uf (grão A)", route: "resumo", o: { filters: { years: [yN], isCsap: true }, groupBy: ["uf"], metrics: M4, orderBy: "n_hospitalizations DESC" } },
  { name: "exclusão agrupada (grão A)", route: "resumo", o: { filters: { years: [yN] }, groupBy: ["exclusion"], metrics: M4, orderBy: "exclusion" } },
  { name: "cid_revision × year (grão A)", route: "resumo", o: { filters: { years: span }, groupBy: ["cid_revision", "year"], metrics: M4, orderBy: "year" } },
  { name: "uma uf, um capítulo (grão A)", route: "resumo", o: { filters: { years: [yN], ufs: ["MG"], cidChapters: [9] }, groupBy: ["uf"], metrics: M4 } },
  { name: "compare_regions por óbitos (grão A)", route: "resumo", o: { filters: { years: [yN] }, groupBy: ["uf"], metrics: ["n", "deaths"], orderBy: "deaths DESC", limit: 10 } },

  // Grão B: os recortes demográficos.
  { name: "sexo filtrado, por uf (grão B)", route: "estratos", o: { filters: { years: [yN], sex: "F" }, groupBy: ["uf"], metrics: M4, orderBy: "uf" } },
  { name: "sexo agrupado por ano (grão B)", route: "estratos", o: { filters: { years: span }, groupBy: ["sex", "year"], metrics: M4, orderBy: "year" } },
  { name: "raça agrupada (grão B)", route: "estratos", o: { filters: { years: [yN] }, groupBy: ["race"], metrics: M4, orderBy: "race" } },
  { name: "faixa 0-4 (grão B)", route: "estratos", o: { filters: { years: [yN], ageMin: 0, ageMax: 4 }, groupBy: ["uf"], metrics: M4, orderBy: "uf" } },
  { name: "faixa 60+ (grão B)", route: "estratos", o: { filters: { years: [yN], ageMin: 60 }, groupBy: ["sex"], metrics: M4, orderBy: "sex" } },
  { name: "80 e mais (grão B)", route: "estratos", o: { filters: { years: [yN], ageMin: 80 }, metrics: M4 } },
  { name: "só age_max alinhado (grão B)", route: "estratos", o: { filters: { years: [yN], ageMax: 19 }, groupBy: ["uf"], metrics: M4, orderBy: "uf" } },
  { name: "sexo + raça + capítulo (grão B)", route: "estratos", o: { filters: { years: [yN], sex: "M", races: ["parda"], cidChapters: [9] }, groupBy: ["race"], metrics: M4 } },

  // O que o pré-agregado NÃO representa: tem de cair no cubo, com o mesmo número.
  { name: "mês agrupado → cubo", route: "cubo", o: { filters: { years: [yN] }, groupBy: ["month"], metrics: M4, orderBy: "month" } },
  { name: "mês filtrado → cubo", route: "cubo", o: { filters: { years: [yN], months: [1, 2] }, groupBy: ["uf"], metrics: M4, orderBy: "uf" } },
  { name: "categoria CID de 3 dígitos → cubo", route: "cubo", o: { filters: { years: [yN] }, groupBy: ["cid_group"], metrics: M4, orderBy: "n_hospitalizations DESC", limit: 20 } },
  { name: "grupo CSAP → cubo", route: "cubo", o: { filters: { years: [yN] }, groupBy: ["csap_group"], metrics: M4, orderBy: "n_hospitalizations DESC" } },
  { name: "idade 0-17 não alinha → cubo", route: "cubo", o: { filters: { years: [yN], ageMin: 0, ageMax: 17 }, groupBy: ["uf"], metrics: M4, orderBy: "uf" } },
  { name: "idade simples agrupada → cubo", route: "cubo", o: { filters: { years: [yN] }, groupBy: ["age"], metrics: M4, orderBy: "age", limit: 30 } },
];

let fails = 0;
for (const s of scenarios) {
  setCausasSummaryStateForTests(null);
  const classico = await queryCausas(s.o);
  const rotaClassica = lastCausasQueryPath();
  setCausasSummaryStateForTests(state);
  const rapido = await queryCausas(s.o);
  const rota = lastCausasQueryPath();
  const igual = J(classico) === J(rapido);
  if (!igual || rota !== s.route || rotaClassica !== "cubo") {
    fails++;
    console.error(`DIVERGE: ${s.name} (rota ${rota}, esperada ${s.route}, iguais=${igual})`);
    if (!igual) console.error(`  cubo:  ${J(classico).slice(0, 320)}\n  rápido: ${J(rapido).slice(0, 320)}`);
  } else {
    console.error(`igual: ${s.name} [${rota}] (${classico.length} linhas)`);
  }
}

// Ano VELHO no meio do pedido (rebuild sem nova derivação): o pré-agregado não
// vale, a resposta continua idêntica porque a consulta cai no cubo.
if (years.length > 1) {
  const o = { filters: { years: [y0, yN] }, groupBy: ["year"], metrics: M4, orderBy: "year" };
  setCausasSummaryStateForTests(null);
  const classico = await queryCausas(o);
  setCausasSummaryStateForTests({ ...state, freshYears: new Set([yN]) });
  const rapido = await queryCausas(o);
  const rota = lastCausasQueryPath();
  if (J(classico) !== J(rapido) || rota !== "cubo") {
    fails++;
    console.error(`DIVERGE: ano velho no pedido (rota ${rota}, iguais=${J(classico) === J(rapido)})`);
  } else {
    console.error(`igual: ano velho no pedido cai fora do pré-agregado [${rota}]`);
  }
}

// --- roteamento no nível dos ARGUMENTOS (o que decide baixar 1,25 GB) ------
setCausasSummaryStateForTests(state);
const { __causasSummaryCoversCallForTests } = await import("../dist/tools.js");
if (typeof __causasSummaryCoversCallForTests === "function") {
  const casos = [
    ["get_hospitalizations", { year: [yN] }, "resumo"],
    ["get_hospitalizations", { year: [yN], group_by: ["year", "uf", "cid_chapter"] }, "resumo"],
    ["get_hospitalizations", { year: [yN], is_csap: true, group_by: ["uf"] }, "resumo"],
    ["get_hospitalizations", { year: [yN], group_by: ["month"] }, null],
    ["get_hospitalizations", { year: [yN], month: [3] }, null],
    ["get_hospitalizations", { year: [yN], group_by: ["cid_group"] }, null],
    ["get_hospitalizations", { year: [yN], group_by: ["csap_group"] }, null],
    ["get_hospitalizations", { year: [yN], group_by: ["age"] }, null],
    ["get_hospitalizations", { year: [yN], sex: "F" }, "estratos"],
    ["get_hospitalizations", { year: [yN], group_by: ["race"] }, "estratos"],
    ["get_hospitalizations", { year: [yN], age_min: 60 }, "estratos"],
    ["get_hospitalizations", { year: [yN], age_min: 0, age_max: 17 }, null],
    ["get_hospitalizations", {}, null],
    ["compare_regions", { year: [yN], is_csap: true }, "resumo"],
    // Sem is_csap o cubo LEVE de séries já resolve (1,2 MB) e tem precedência.
    ["compare_regions", { year: [yN] }, null],
    ["get_hospitalization_rates", { year: [yN], sex: "M" }, "estratos"],
    ["get_hospitalization_rates", { year: [yN], age_min: 5, age_max: 9 }, "estratos"],
    ["get_hospitalization_rates", { year: [yN], age_min: 1 }, null],
    ["get_hospitalization_rates", { year: [yN] }, null],
    ["get_icsap", { year: [yN] }, null],
    ["rank_csap_groups", { year: [yN] }, null],
  ];
  for (const [tool, a, esperado] of casos) {
    const got = __causasSummaryCoversCallForTests(tool, a);
    if (got !== esperado) {
      fails++;
      console.error(`ROTA ERRADA: ${tool} ${J(a)} → ${got}, esperado ${esperado}`);
    } else {
      console.error(`rota ok: ${tool} ${J(a)} → ${got ?? "cubo/séries"}`);
    }
  }
} else {
  fails++;
  console.error("ROTA: __causasSummaryCoversCallForTests não exportado");
}

setCausasSummaryStateForTests(null);
rmSync(tmp, { recursive: true, force: true });
if (fails) fail(`${fails} falha(s)`);
console.error(`CAUSAS-ROUTING OK (${scenarios.length + (years.length > 1 ? 1 : 0)} cenários idênticos + roteamento conferido; anos ${y0}–${yN})`);
