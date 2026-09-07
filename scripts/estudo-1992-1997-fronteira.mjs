// Temporário (estudo 1992–1997): nas competências 1998-01..04 (já CID-10 e
// DT_INTER em YYYYMMDD), quantas AIH são de internações de 1997 e como
// vem o DIAG_PRINC delas — é a janela de fechamento do cubo de 1997.
import { DuckDBInstance } from "@duckdb/node-api";

const endpoint = "5c499208eebced4e34bd98ffa204f2fb.r2.cloudflarestorage.com";
const inst = await DuckDBInstance.create();
const c = await inst.connect();
await c.run(`INSTALL httpfs; LOAD httpfs;`);
await c.run(`SET s3_endpoint='${endpoint}'; SET s3_access_key_id='28c72d4b3e1140fa468e367ae472b522'; SET s3_secret_access_key='2937b2106736e2ba64e24e92f2be4e6c312bba3355586e41ce634b14c1482951';
SET s3_region='auto'; SET s3_url_style='path'; SET s3_use_ssl=true;`);
const glob = `s3://healthbr-data/sih/rd/ano=1998/mes=0[1-4]/uf=*/part-0.parquet`;
const r = await c.runAndReadAll(`
  SELECT mes,
    count(*)::VARCHAR AS n,
    sum(CASE WHEN length(CAST(DT_INTER AS VARCHAR)) = 8 THEN 1 ELSE 0 END)::VARCHAR AS dt8,
    sum(CASE WHEN length(CAST(DT_INTER AS VARCHAR)) = 6 THEN 1 ELSE 0 END)::VARCHAR AS dt6,
    sum(CASE WHEN substr(CAST(DT_INTER AS VARCHAR),1,4) = '1997' THEN 1 ELSE 0 END)::VARCHAR AS inter_1997,
    sum(CASE WHEN substr(CAST(DT_INTER AS VARCHAR),1,4) = '1997' AND regexp_matches(CAST(DIAG_PRINC AS VARCHAR), '^[A-Z][0-9]') THEN 1 ELSE 0 END)::VARCHAR AS inter_1997_cid10,
    sum(CASE WHEN substr(CAST(DT_INTER AS VARCHAR),1,4) = '1997' AND regexp_matches(CAST(DIAG_PRINC AS VARCHAR), '^[0-9]{6}$') THEN 1 ELSE 0 END)::VARCHAR AS inter_1997_cid9,
    sum(CASE WHEN substr(CAST(DT_INTER AS VARCHAR),1,4) < '1997' THEN 1 ELSE 0 END)::VARCHAR AS inter_antes_1997,
    sum(CASE WHEN regexp_matches(CAST(DIAG_PRINC AS VARCHAR), '^[A-Z][0-9]') THEN 1 ELSE 0 END)::VARCHAR AS cid10,
    sum(CASE WHEN regexp_matches(CAST(DIAG_PRINC AS VARCHAR), '^[0-9]{6}$') THEN 1 ELSE 0 END)::VARCHAR AS cid9_6dig,
    sum(CASE WHEN MUNIC_RES IS NULL OR trim(CAST(MUNIC_RES AS VARCHAR)) = '' OR CAST(MUNIC_RES AS VARCHAR) = '000000' THEN 1 ELSE 0 END)::VARCHAR AS munic_res_vazio,
    sum(CASE WHEN CAST(SEXO AS VARCHAR) = '2' THEN 1 ELSE 0 END)::VARCHAR AS sexo2
  FROM read_parquet('${glob}', hive_partitioning = true, union_by_name = true)
  GROUP BY ALL ORDER BY ALL`);
console.log(JSON.stringify(r.getRowObjectsJS(), null, 1));
