#!/usr/bin/env node
// Equivalência dos PRÉ-AGREGADOS da ICSAP (PLAN-005): o caminho rápido
// (resumo) e o denominador por estratos têm de devolver EXATAMENTE o que o
// caminho clássico devolve — byte a byte no JSON — em cenários que cobrem o
// roteamento inteiro. Deriva resumo + estratos AQUI, dos mesmos cubos da
// pasta de dados (o SQL canônico é o do produtor: healthbr-data
// scripts/pipeline/sih-cubos/derive-icsap-summary.mjs; esta cópia serve à
// prova e denuncia divergência de desenho se o produtor mudar).
//
// Uso:
//   node scripts/summary-equivalence.mjs --fixtures tests/fixtures/sih   (CI)
//   node scripts/summary-equivalence.mjs --fixtures data                 (34 anos)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : [])).filter((p) => p.length),
);
const dataDir = resolve(String(args.fixtures ?? "tests/fixtures/sih"));
process.env.SIH_DATA_DIR = dataDir;
process.env.SIH_CUBES_CACHE = "off";

const { DuckDBInstance } = await import("@duckdb/node-api");
const { queryIcsap, calculateIcsapIndicators, lastIcsapAggregatePath } = await import("../dist/db/duckdb.js");
const { setIcsapSummaryStateForTests } = await import("../dist/cache.js");
const { readdirSync } = await import("node:fs");

const posix = (p) => p.replace(/\\/g, "/");
const J = (v) => JSON.stringify(v);

function fail(msg) {
  console.error(`summary-equivalence: ${msg}`);
  process.exit(1);
}

// --- deriva resumo + estratos dos cubos da pasta (mesmo SQL do produtor) ---
// Anos pelos arquivos ICSAP presentes (a prova de 34 anos roda numa pasta só
// com os cubos ICSAP do canal; getAvailableYears exige os de causas).
const years = readdirSync(dataDir)
  .map((f) => f.match(/^sih_icsap_(\d{4})\.parquet$/)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((a, b) => a - b);
if (years.length === 0) fail(`nenhum cubo ICSAP em ${dataDir}`);
const tmp = mkdtempSync(join(tmpdir(), "sih-summary-equiv-"));
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const ESTRATO_COLS = "year, uf, municipality_code, cid_revision, sex, age, race, exclusion, n_total";
const estratosPaths = new Map();
for (const y of years) {
  const out = join(tmp, `sih_icsap_estratos_${y}.parquet`);
  await conn.run(`COPY (SELECT DISTINCT ${ESTRATO_COLS} FROM read_parquet('${posix(join(dataDir, `sih_icsap_${y}.parquet`))}') ORDER BY ${ESTRATO_COLS}) TO '${posix(out)}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  estratosPaths.set(y, out);
}
const resumoPath = join(tmp, "sih_icsap_resumo.parquet");
await conn.run(`COPY (
  WITH base AS (SELECT * FROM read_parquet('${posix(join(dataDir, "sih_icsap_*.parquet"))}', union_by_name = true)),
  universos(universe) AS (VALUES ('csapaih'), ('all')),
  estr AS (SELECT DISTINCT year, uf, municipality_code, COALESCE(cid_revision, 10) AS cid_revision, sex, age, race, exclusion, n_total FROM base),
  den AS (SELECT u.universe, e.year, e.uf, e.cid_revision, SUM(e.n_total) AS n_total FROM estr e CROSS JOIN universos u WHERE u.universe = 'all' OR e.exclusion IS NULL GROUP BY 1,2,3,4),
  num AS (SELECT u.universe, b.year, b.uf, COALESCE(b.cid_revision, 10) AS cid_revision, b.csap_group, SUM(b.n) AS n_icsap, SUM(b.days) AS total_days, SUM(CAST(b.value AS DECIMAL(18,2))) AS total_value, SUM(b.deaths) AS deaths
    FROM base b CROSS JOIN universos u WHERE b.csap_group IS NOT NULL AND (u.universe = 'all' OR b.exclusion IS NULL) GROUP BY 1,2,3,4,5)
  SELECT d.universe, d.year, d.uf, d.cid_revision, n.csap_group, n.n_icsap, n.total_days, n.total_value, n.deaths, d.n_total
  FROM den d LEFT JOIN num n USING (universe, year, uf, cid_revision)
  ORDER BY d.universe, d.year, d.uf, d.cid_revision, n.csap_group
) TO '${posix(resumoPath)}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
conn.closeSync?.();
inst.closeSync?.();

const state = { resumoPath, freshYears: new Set(years), estratosPaths };

// --- cenários: cobrem grão do resumo, filtros finos (estratos) e ano velho ---
const y0 = years[0];
const yN = years[years.length - 1];
const span = years.slice(0, Math.min(3, years.length));
const scenarios = [
  { name: "trends year×uf (grão)", route: "resumo", fn: (o) => queryIcsap(o), o: { filters: { years: span }, groupBy: ["year", "uf"], orderBy: "year" } },
  { name: "uf com limit por n_icsap (grão)", route: "resumo", fn: (o) => queryIcsap(o), o: { filters: { years: span }, groupBy: ["uf"], orderBy: "n_icsap DESC", limit: 5 } },
  { name: "csap_group universo all (grão)", route: "resumo", fn: (o) => queryIcsap(o), o: { filters: { years: [yN] }, groupBy: ["csap_group"], orderBy: "n_icsap DESC", universe: "all" } },
  { name: "totais sem grupo (grão)", route: "resumo", fn: (o) => calculateIcsapIndicators(o), o: { filters: { years: span }, groupBy: [] } },
  { name: "cid_revision × year (grão)", route: "resumo", fn: (o) => queryIcsap(o), o: { filters: { years: span }, groupBy: ["cid_revision", "year"], orderBy: "year" } },
  { name: "ufs + csapGroups por year (grão)", route: "resumo", fn: (o) => queryIcsap(o), o: { filters: { years: [yN], ufs: ["MG", "RR"], csapGroups: ["g01", "g03"] }, groupBy: ["year"] } },
  { name: "sexo (fino → estratos)", route: "estratos", fn: (o) => queryIcsap(o), o: { filters: { years: span, sex: "F" }, groupBy: ["uf"], orderBy: "uf" } },
  { name: "faixa etária (fino → estratos)", route: "estratos", fn: (o) => calculateIcsapIndicators(o), o: { filters: { years: [yN], ageMin: 60 }, groupBy: ["sex"] } },
  { name: "raça agrupada (fino → estratos)", route: "estratos", fn: (o) => queryIcsap(o), o: { filters: { years: [yN] }, groupBy: ["race"], orderBy: "race" } },
];

let fails = 0;
for (const s of scenarios) {
  setIcsapSummaryStateForTests(null);
  const classico = await s.fn(s.o);
  setIcsapSummaryStateForTests(state);
  const rapido = await s.fn(s.o);
  const route = lastIcsapAggregatePath();
  const equal = J(classico) === J(rapido);
  if (!equal || route !== s.route) {
    fails++;
    console.error(`DIVERGE: ${s.name} (rota ${route}, esperada ${s.route}, iguais=${equal})`);
    if (!equal) console.error(`  clássico: ${J(classico).slice(0, 300)}\n  rápido:   ${J(rapido).slice(0, 300)}`);
  } else {
    console.error(`igual: ${s.name} [${route}] (${classico.length} linhas)`);
  }
}

// ano VELHO no meio do pedido: resumo não vale, resultado idêntico mesmo assim
if (years.length > 1) {
  setIcsapSummaryStateForTests(null);
  const o = { filters: { years: [y0, yN] }, groupBy: ["year"], orderBy: "year" };
  const classico = await queryIcsap(o);
  setIcsapSummaryStateForTests({ ...state, freshYears: new Set([yN]) });
  const rapido = await queryIcsap(o);
  const route = lastIcsapAggregatePath();
  if (J(classico) !== J(rapido) || route === "resumo") {
    fails++;
    console.error(`DIVERGE: ano velho no pedido (rota ${route}, iguais=${J(classico) === J(rapido)})`);
  } else {
    console.error(`igual: ano velho no pedido cai fora do resumo [${route}]`);
  }
}

setIcsapSummaryStateForTests(null);
rmSync(tmp, { recursive: true, force: true });
if (fails) fail(`${fails} cenário(s) divergente(s)`);
console.error(`SUMMARY-EQUIVALENCE OK (${scenarios.length + (years.length > 1 ? 1 : 0)} cenários, anos ${y0}–${yN})`);
