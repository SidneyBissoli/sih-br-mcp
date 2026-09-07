// Mede, no healthbr-data, a qualidade dos campos que o cubo usa nas
// competências 1992–1997 (era CID-9 do SIH): DT_INTER vazio/inválido,
// MUNIC_RES vazio, COD_IDADE ignorado, DIAG_PRINC fora do padrão de
// 6 dígitos ou com dígito verificador errado, e a distribuição dos
// códigos. Evidência de docs/analise-002-sih-1992-1997.md. Lê direto do
// R2 com DuckDB (httpfs), um ano de competência por vez, as 27 UFs.
//
// Uso:  node scripts/estudo-1992-1997.mjs <ano_competencia> <pasta_saida>
// Saídas: <pasta>/q_<ano>.csv (ano, mes, uf), <pasta>/diag_<ano>.csv
// (DIAG_PRINC × n), <pasta>/lag_<ano>.csv (ano/mes de DT_INTER × n).
//
// Token público somente-leitura do healthbr-data (README do repositório);
// pode ser sobrescrito por HEALTHBR_R2_ENDPOINT/ACCESS_KEY/SECRET_KEY.
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [ano, outDir] = process.argv.slice(2);
if (!ano || !outDir) {
  console.error("uso: node scripts/estudo-1992-1997.mjs <ano_competencia> <pasta_saida>");
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

const glob = `s3://healthbr-data/sih/rd/ano=${ano}/mes=*/uf=*/part-0.parquet`;
const t0 = Date.now();

// colunas presentes no ano (o esquema muda: MUNIC_RES só de 1994)
const cols = (await c.runAndReadAll(
  `SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet('${glob}', hive_partitioning = true, union_by_name = true))`
)).getRowObjectsJS().map((r) => r.column_name);
const has = (x) => cols.includes(x);
console.log(`${ano}: ${cols.length} colunas; MUNIC_RES=${has("MUNIC_RES")} UF_ZI=${has("UF_ZI")} MUNIC_MOV=${has("MUNIC_MOV")} DIAG_SEC=${has("DIAG_SEC")}`);

const S = (x) => `CAST(${x} AS VARCHAR)`;
const vazio = (x) => `(${x} IS NULL OR trim(${S(x)}) = '')`;
const dvExpr = `((11 - ((6*substr(${S("DIAG_PRINC")},1,1)::INT + 5*substr(${S("DIAG_PRINC")},2,1)::INT + 4*substr(${S("DIAG_PRINC")},3,1)::INT + 3*substr(${S("DIAG_PRINC")},4,1)::INT + 2*substr(${S("DIAG_PRINC")},5,1)::INT) % 11)) % 11) % 10`;
const diag6 = `regexp_matches(${S("DIAG_PRINC")}, '^[0-9]{6}$')`;
const dtIntOk = `regexp_matches(${S("DT_INTER")}, '^[0-9]{6}$') AND try_strptime(${S("DT_INTER")}, '%y%m%d') IS NOT NULL`;

const base = `read_parquet('${glob}', hive_partitioning = true, union_by_name = true)`;

const q1 = await c.runAndReadAll(`
  SELECT ano, mes, uf,
    count(*)::VARCHAR AS n,
    sum(CASE WHEN ${vazio("DT_INTER")} THEN 1 ELSE 0 END)::VARCHAR AS dt_inter_vazio,
    sum(CASE WHEN NOT ${vazio("DT_INTER")} AND NOT (${dtIntOk}) THEN 1 ELSE 0 END)::VARCHAR AS dt_inter_invalido,
    ${has("MUNIC_RES") ? `sum(CASE WHEN ${vazio("MUNIC_RES")} OR ${S("MUNIC_RES")} = '000000' THEN 1 ELSE 0 END)::VARCHAR` : `'NA'`} AS munic_res_vazio,
    ${has("UF_ZI") ? `sum(CASE WHEN ${vazio("UF_ZI")} THEN 1 ELSE 0 END)::VARCHAR` : `'NA'`} AS uf_zi_vazio,
    ${has("MUNIC_MOV") ? `sum(CASE WHEN ${vazio("MUNIC_MOV")} OR ${S("MUNIC_MOV")} = '000000' THEN 1 ELSE 0 END)::VARCHAR` : `'NA'`} AS munic_mov_vazio,
    sum(CASE WHEN ${S("COD_IDADE")} = '0' OR ${vazio("COD_IDADE")} THEN 1 ELSE 0 END)::VARCHAR AS idade_ignorada,
    sum(CASE WHEN ${vazio("DIAG_PRINC")} THEN 1 ELSE 0 END)::VARCHAR AS diag_vazio,
    sum(CASE WHEN NOT ${vazio("DIAG_PRINC")} AND NOT ${diag6} THEN 1 ELSE 0 END)::VARCHAR AS diag_nao6,
    sum(CASE WHEN ${diag6} AND ${dvExpr} <> substr(${S("DIAG_PRINC")},6,1)::INT THEN 1 ELSE 0 END)::VARCHAR AS diag_dv_errado,
    ${has("DIAG_SEC") ? `sum(CASE WHEN NOT ${vazio("DIAG_SEC")} THEN 1 ELSE 0 END)::VARCHAR` : `'NA'`} AS diag_sec_preenchido,
    sum(CASE WHEN ${S("MORTE")} = '1' THEN 1 ELSE 0 END)::VARCHAR AS obitos,
    sum(CASE WHEN ${S("SEXO")} NOT IN ('1','3') THEN 1 ELSE 0 END)::VARCHAR AS sexo_outro,
    sum(COALESCE(try_cast(${S("DIAS_PERM")} AS BIGINT), 0))::VARCHAR AS dias_perm,
    avg(try_cast(${S("VAL_TOT")} AS DOUBLE))::VARCHAR AS val_tot_medio,
    min(CASE WHEN ${dtIntOk} THEN ${S("DT_INTER")} END) AS dt_inter_min,
    max(CASE WHEN ${dtIntOk} THEN ${S("DT_INTER")} END) AS dt_inter_max
  FROM ${base}
  GROUP BY ALL ORDER BY ALL`);
const rows1 = q1.getRowObjectsJS();
const csv = (rows) => {
  const h = Object.keys(rows[0]);
  return [h.join(","), ...rows.map((r) => h.map((k) => r[k] ?? "").join(","))].join("\n");
};
writeFileSync(join(outDir, `q_${ano}.csv`), csv(rows1));
const total = rows1.reduce((s, r) => s + Number(r.n), 0);
console.log(`${ano}: q1 ${rows1.length} linhas, ${total} AIH, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const q2 = await c.runAndReadAll(`
  SELECT ${S("DIAG_PRINC")} AS diag, count(*)::VARCHAR AS n,
    sum(CASE WHEN ${S("MORTE")} = '1' THEN 1 ELSE 0 END)::VARCHAR AS obitos
  FROM ${base} GROUP BY ALL ORDER BY ALL`);
writeFileSync(join(outDir, `diag_${ano}.csv`), csv(q2.getRowObjectsJS()));
console.log(`${ano}: q2 ${q2.rowCount} códigos distintos, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const q3 = await c.runAndReadAll(`
  SELECT ano, mes,
    CASE WHEN ${dtIntOk} THEN substr(${S("DT_INTER")},1,2) ELSE '' END AS ano_inter,
    CASE WHEN ${dtIntOk} THEN substr(${S("DT_INTER")},3,2) ELSE '' END AS mes_inter,
    count(*)::VARCHAR AS n
  FROM ${base} GROUP BY ALL ORDER BY ALL`);
writeFileSync(join(outDir, `lag_${ano}.csv`), csv(q3.getRowObjectsJS()));
console.log(`${ano}: q3 ${q3.rowCount} linhas, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
