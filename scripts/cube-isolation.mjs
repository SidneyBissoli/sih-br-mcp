#!/usr/bin/env node
// O CUBO SÓ LÊ CUBO, mesmo com os pré-agregados na mesma pasta.
//
// Este teste existe por causa de um defeito de 10/09/2026, achado por um
// usuário e não pelas provas: `getParquetPattern` devolvia o glob
// `sih_<tipo>_*.parquet`, que também casa com os PRÉ-AGREGADOS que o servidor
// baixa para a MESMA pasta (`sih_causas_resumo.parquet`,
// `sih_causas_estratos_YYYY.parquet` e os equivalentes da ICSAP). Com
// `union_by_name` eles entravam na leitura do cubo e somavam junto, calados:
// `get_hospitalizations` por ano e mês devolvia 26.648.728 internações em 2023,
// o DOBRO das 13.324.364 reais, numa linha de mês NULO que não deveria existir.
//
// Por que nenhuma prova pegou: `equiv:summary`, `equiv:series` e `equiv:causas`
// derivam os pré-agregados numa pasta TEMPORÁRIA. Os dois lados nunca
// conviviam. Aqui eles convivem, que é a situação de produção.
//
// Uso: node scripts/cube-isolation.mjs --fixtures tests/fixtures/sih
import { copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : [])).filter((p) => p.length),
);
const fixtures = resolve(String(args.fixtures ?? "tests/fixtures/sih"));

// Pasta LIMPA: cópia da fixture, só cubos. É a referência.
const limpa = mkdtempSync(join(tmpdir(), "sih-cubo-limpo-"));
cpSync(fixtures, limpa, { recursive: true });
const anos = readdirSync(limpa)
  .map((f) => f.match(/^sih_causas_(\d{4})\.parquet$/)?.[1])
  .filter(Boolean)
  .map(Number);
if (anos.length === 0) {
  console.error(`cube-isolation: nenhum cubo de causas em ${fixtures}`);
  process.exit(1);
}

process.env.SIH_DATA_DIR = limpa;
process.env.SIH_CUBES_CACHE = "off";
process.env.SIH_FRESHNESS_CHECK = "off";

const { DuckDBInstance } = await import("@duckdb/node-api");
const { queryCausas, queryIcsap, rankCsapGroups, querySeriesYearly, cubeFiles } = await import("../dist/db/duckdb.js");

const J = (v) => JSON.stringify(v);
const posix = (p) => p.replace(/\\/g, "/");
let falhas = 0;
const ok = (cond, msg) => {
  console.error(`${cond ? "ok  " : "FALHA"} ${msg}`);
  if (!cond) falhas++;
};

// As consultas que o glob corrompia: as que agrupam por uma coluna que o
// pré-agregado NÃO tem (o filtro por essa coluna, sozinho, já excluía as
// linhas intrusas — por isso o defeito escapou de tanta gente).
const y = anos[anos.length - 1];
const M4 = ["n", "days", "value", "deaths"];
const consultas = [
  ["causas por ano e mês", () => queryCausas({ filters: { years: [y] }, groupBy: ["year", "month"], metrics: M4, orderBy: "month" })],
  ["causas por categoria CID", () => queryCausas({ filters: { years: [y] }, groupBy: ["cid_group"], metrics: M4, orderBy: "n_hospitalizations DESC", limit: 10 })],
  ["causas por grupo CSAP", () => queryCausas({ filters: { years: [y] }, groupBy: ["csap_group"], metrics: M4, orderBy: "csap_group" })],
  ["causas por idade simples", () => queryCausas({ filters: { years: [y] }, groupBy: ["age"], metrics: M4, orderBy: "age", limit: 20 })],
  ["causas sem agrupamento", () => queryCausas({ filters: { years: [y] }, metrics: M4 })],
  ["icsap por uf", () => queryIcsap({ filters: { years: [y] }, groupBy: ["uf"] })],
  ["icsap por município", () => queryIcsap({ filters: { years: [y] }, groupBy: ["municipality_code"], orderBy: "n_icsap DESC", limit: 10 })],
  ["ranking de grupos CSAP", () => rankCsapGroups({ filters: { years: [y] }, limit: 10 })],
  ["séries anuais por uf", () => querySeriesYearly({ years: [y], groupBy: ["uf"], orderBy: "uf" })],
];

const referencia = [];
for (const [nome, fn] of consultas) referencia.push([nome, J(await fn())]);
ok(cubeFiles("causas").length === anos.length, `pasta limpa: cubeFiles vê ${cubeFiles("causas").length} cubo(s) de causas`);

// Agora a MESMA pasta ganha os pré-agregados, com os nomes reais do canal.
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const cubo = posix(join(limpa, `sih_causas_${y}.parquet`));
await conn.run(`COPY (
  SELECT year, uf, cid_chapter, COALESCE(cid_revision, 10) AS cid_revision, is_csap, exclusion,
         SUM(n) AS n, SUM(days) AS days, SUM(CAST(value AS DECIMAL(18,2))) AS value, SUM(deaths) AS deaths
  FROM read_parquet('${cubo}') GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6
) TO '${posix(join(limpa, "sih_causas_resumo.parquet"))}' (FORMAT PARQUET)`);
copyFileSync(join(limpa, "sih_causas_resumo.parquet"), join(limpa, `sih_causas_estratos_${y}.parquet`));
const icsap = posix(join(limpa, `sih_icsap_${y}.parquet`));
await conn.run(`COPY (
  SELECT 'csapaih' AS universe, year, uf, COALESCE(cid_revision, 10) AS cid_revision, csap_group,
         SUM(n) AS n_icsap, SUM(days) AS total_days, SUM(CAST(value AS DECIMAL(18,2))) AS total_value,
         SUM(deaths) AS deaths, SUM(n_total) AS n_total
  FROM read_parquet('${icsap}') GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5
) TO '${posix(join(limpa, "sih_icsap_resumo.parquet"))}' (FORMAT PARQUET)`);
copyFileSync(join(limpa, "sih_icsap_resumo.parquet"), join(limpa, `sih_icsap_estratos_${y}.parquet`));
const serie = posix(join(limpa, `sih_series_${y}.parquet`));
await conn.run(`COPY (SELECT * FROM read_parquet('${serie}')) TO '${posix(join(limpa, "sih_series_resumo.parquet"))}' (FORMAT PARQUET)`);
conn.closeSync?.();
inst.closeSync?.();

ok(cubeFiles("causas").length === anos.length, `com pré-agregados ao lado: cubeFiles ainda vê ${cubeFiles("causas").length} cubo(s) de causas`);
ok(cubeFiles("icsap").length === anos.length, `com pré-agregados ao lado: cubeFiles ainda vê ${cubeFiles("icsap").length} cubo(s) de ICSAP`);
ok(cubeFiles("series").length === anos.length, `com pré-agregados ao lado: cubeFiles ainda vê ${cubeFiles("series").length} cubo(s) de séries`);

for (const [nome, esperado] of referencia) {
  const fn = consultas.find(([n]) => n === nome)[1];
  const agora = J(await fn());
  if (agora !== esperado) {
    falhas++;
    console.error(`FALHA ${nome}: mudou com os pré-agregados na pasta\n  limpo: ${esperado.slice(0, 240)}\n  agora: ${agora.slice(0, 240)}`);
  } else {
    console.error(`ok   ${nome}: idêntico com os pré-agregados na pasta`);
  }
}

// A linha de mês NULO é a assinatura do defeito: não pode existir.
const porMes = await queryCausas({ filters: { years: [y] }, groupBy: ["year", "month"], metrics: ["n"], orderBy: "month" });
ok(porMes.every((r) => r.month !== null), `por ano e mês: nenhuma linha com month NULO (${porMes.length} linhas)`);

// E o PERIGO ainda está na pasta: ler pelo GLOB, como a versão defeituosa
// fazia, tem de dar resposta DIFERENTE. Sem esta asserção, o teste passaria
// numa pasta onde os pré-agregados não existissem, provando nada.
{
  const inst2 = await DuckDBInstance.create(":memory:");
  const conn2 = await inst2.connect();
  const glob = posix(join(limpa, "sih_causas_*.parquet"));
  const rows = (
    await conn2.runAndReadAll(
      `SELECT month, SUM(n) AS n FROM read_parquet('${glob}', union_by_name = true) WHERE year = ${y} GROUP BY month ORDER BY month`,
    )
  ).getRowObjectsJS();
  conn2.closeSync?.();
  inst2.closeSync?.();
  const nulas = rows.filter((r) => r.month === null);
  ok(nulas.length > 0, `o glob AINDA leria os pré-agregados (${nulas.length} linha(s) de mês nulo) — o perigo está montado`);
  const totalCubo = porMes.reduce((s, r) => s + Number(r.n_hospitalizations), 0);
  const totalGlob = rows.reduce((s, r) => s + Number(r.n), 0);
  ok(totalGlob > totalCubo, `o glob infla o total (${totalGlob.toLocaleString("pt-BR")} contra ${totalCubo.toLocaleString("pt-BR")} do cubo)`);
}

rmSync(limpa, { recursive: true, force: true });
if (falhas) {
  console.error(`cube-isolation: ${falhas} falha(s)`);
  process.exit(1);
}
console.error(`CUBE-ISOLATION OK (${consultas.length} consultas idênticas com os pré-agregados na mesma pasta; ano ${y})`);
