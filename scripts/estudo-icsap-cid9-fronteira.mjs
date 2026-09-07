// Validação empírica da lista ICSAP derivada em CID-9 (docs/analise-003):
// compara a participação de cada grupo ICSAP nas AIH codificadas em CID-9
// (competências até 1997-12) com a participação nas AIH codificadas em
// CID-10 (competências de 1998) lendo o healthbr-data direto do R2 com
// DuckDB (httpfs). Três recortes:
//   A) mesmas internações, dois códigos: internações com DT_INTER em
//      dez/1997 faturadas em 1997-12 (CID-9) vs faturadas em 1998-01..04
//      (CID-10) — por grupo e por UF;
//   B) controle de vizinhança: competência 1997-12 inteira vs 1998-01
//      inteira, por grupo;
//   C) série: 1997 e 1998 inteiros, por mês e grupo (sazonalidade).
//
// Uso:  node scripts/estudo-icsap-cid9-fronteira.mjs <lista_cid9.csv> <lista_cid10.csv> <pasta_saida> [A|B|C|ABC]
// lista_cid9.csv:  code6,cid9,grp,diag,variant   (variant vazio = núcleo)
// lista_cid10.csv: prefix,len,grp,diag
// Saídas: <pasta>/A_dez1997.csv, <pasta>/B_competencias.csv, <pasta>/C_serie.csv
// Token público somente-leitura do healthbr-data (README do repositório).
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [l9, l10, outDir, modes = "ABC"] = process.argv.slice(2);
if (!l9 || !l10 || !outDir) {
  console.error("uso: node scripts/estudo-icsap-cid9-fronteira.mjs <lista_cid9.csv> <lista_cid10.csv> <pasta_saida> [A|B|C|ABC]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const endpoint = (process.env.HEALTHBR_R2_ENDPOINT ?? "https://5c499208eebced4e34bd98ffa204f2fb.r2.cloudflarestorage.com").replace(/^https?:\/\//, "");
const key = process.env.HEALTHBR_R2_ACCESS_KEY ?? "28c72d4b3e1140fa468e367ae472b522";
const secret = process.env.HEALTHBR_R2_SECRET_KEY ?? "2937b2106736e2ba64e24e92f2be4e6c312bba3355586e41ce634b14c1482951";

const inst = await DuckDBInstance.create();
const c = await inst.connect();
await c.run(`INSTALL httpfs; LOAD httpfs;`);
await c.run(`SET s3_endpoint='${endpoint}'; SET s3_access_key_id='${key}'; SET s3_secret_access_key='${secret}';
SET s3_region='auto'; SET s3_url_style='path'; SET s3_use_ssl=true;`);
const p = (x) => x.replace(/\\/g, "/").replace(/'/g, "''");
await c.run(`CREATE TABLE l9 AS SELECT * FROM read_csv('${p(l9)}', header = true, all_varchar = true);`);
await c.run(`CREATE TABLE l10 AS SELECT * FROM read_csv('${p(l10)}', header = true, all_varchar = true);`);

const S = (x) => `CAST(${x} AS VARCHAR)`;
const rd = (glob) => `read_parquet('${glob}', hive_partitioning = true, union_by_name = true)`;
// classificação CID-9: junção exata pelo código de 6 dígitos; 'grp' e 'variant'
const cls9 = (src) => `
  SELECT s.ano, s.mes, s.uf, s.dt, l9.grp, l9.variant
  FROM (${src}) s LEFT JOIN l9 ON l9.code6 = s.diag`;
// classificação CID-10: prefixo de 4 caracteres primeiro, depois 3
const cls10 = (src) => `
  SELECT s.ano, s.mes, s.uf, s.dt, coalesce(p4.grp, p3.grp) AS grp, '' AS variant
  FROM (${src}) s
  LEFT JOIN l10 p4 ON p4.len = '4' AND p4.prefix = substr(s.diag, 1, 4)
  LEFT JOIN l10 p3 ON p3.len = '3' AND p3.prefix = substr(s.diag, 1, 3)`;
const base = (glob) => `SELECT ano, mes, uf, ${S("DIAG_PRINC")} AS diag, ${S("DT_INTER")} AS dt FROM ${rd(glob)}`;
const csv = (rows) => {
  if (!rows.length) return "";
  const h = Object.keys(rows[0]);
  return [h.join(","), ...rows.map((r) => h.map((k) => r[k] ?? "").join(","))].join("\n");
};
const agg = (inner, where, by) => `
  SELECT ${by}, coalesce(grp, '-') AS grp, coalesce(variant, '') AS variant, count(*)::VARCHAR AS n
  FROM (${inner}) WHERE ${where} GROUP BY ALL ORDER BY ALL`;

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

if (modes.includes("A")) {
  // 1997-12 (CID-9, DT_INTER YYMMDD) — internações de dez/1997
  const a9 = await c.runAndReadAll(agg(cls9(base(`s3://healthbr-data/sih/rd/ano=1997/mes=12/uf=*/part-0.parquet`)),
    `substr(dt, 1, 4) = '9712'`, `'cid9' AS lado, uf`));
  console.log(`A: lado CID-9 ${a9.rowCount} linhas (${el()})`);
  // 1998-01..04 (CID-10, DT_INTER YYYYMMDD) — internações de dez/1997
  const a10 = await c.runAndReadAll(agg(cls10(base(`s3://healthbr-data/sih/rd/ano=1998/mes=0[1-4]/uf=*/part-0.parquet`)),
    `substr(dt, 1, 6) = '199712'`, `'cid10' AS lado, uf`));
  console.log(`A: lado CID-10 ${a10.rowCount} linhas (${el()})`);
  writeFileSync(join(outDir, "A_dez1997.csv"), csv([...a9.getRowObjectsJS(), ...a10.getRowObjectsJS()]));
}
if (modes.includes("B")) {
  const b9 = await c.runAndReadAll(agg(cls9(base(`s3://healthbr-data/sih/rd/ano=1997/mes=1[0-2]/uf=*/part-0.parquet`)),
    `true`, `'cid9' AS lado, ano, mes, uf`));
  const b10 = await c.runAndReadAll(agg(cls10(base(`s3://healthbr-data/sih/rd/ano=1998/mes=0[1-3]/uf=*/part-0.parquet`)),
    `true`, `'cid10' AS lado, ano, mes, uf`));
  console.log(`B: ${b9.rowCount} + ${b10.rowCount} linhas (${el()})`);
  writeFileSync(join(outDir, "B_competencias.csv"), csv([...b9.getRowObjectsJS(), ...b10.getRowObjectsJS()]));
}
if (modes.includes("C")) {
  const c9 = await c.runAndReadAll(agg(cls9(base(`s3://healthbr-data/sih/rd/ano=1997/mes=*/uf=*/part-0.parquet`)),
    `true`, `'cid9' AS lado, ano, mes`));
  console.log(`C: 1997 ${c9.rowCount} linhas (${el()})`);
  const c10 = await c.runAndReadAll(agg(cls10(base(`s3://healthbr-data/sih/rd/ano=1998/mes=*/uf=*/part-0.parquet`)),
    `true`, `'cid10' AS lado, ano, mes`));
  console.log(`C: 1998 ${c10.rowCount} linhas (${el()})`);
  writeFileSync(join(outDir, "C_serie.csv"), csv([...c9.getRowObjectsJS(), ...c10.getRowObjectsJS()]));
}
console.log(`pronto em ${el()}`);
