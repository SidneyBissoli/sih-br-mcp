// Mede, no healthbr-data, em que competências as internações de cada ano
// aparecem — é a evidência da janela de competências dos cubos
// (docs/analise-001-janela-competencia.md). Lê só DT_INTER e as partições,
// direto do R2, com DuckDB (httpfs): um ano de competência inteiro, as 27
// UFs, ~12 milhões de AIH, leva ~25 s.
//
// Uso:  node scripts/lag-competencia.mjs <ano_competencia> [uf] [saida.csv]
//       for y in 2016 … 2026: node scripts/lag-competencia.mjs $y "" lag_$y.csv
// Depois: python scripts/lag-competencia-analise.py <pasta com os CSV>
//
// Token público somente-leitura do healthbr-data (README do repositório);
// pode ser sobrescrito por HEALTHBR_R2_ENDPOINT/ACCESS_KEY/SECRET_KEY.
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync } from "node:fs";

const [ano, ufArg, out] = process.argv.slice(2);
if (!ano) {
  console.error("uso: node scripts/lag-competencia.mjs <ano_competencia> [uf] [saida.csv]");
  process.exit(2);
}
const uf = ufArg && ufArg !== "" ? ufArg : "*";
const endpoint = (process.env.HEALTHBR_R2_ENDPOINT ?? "https://5c499208eebced4e34bd98ffa204f2fb.r2.cloudflarestorage.com").replace(/^https?:\/\//, "");
const key = process.env.HEALTHBR_R2_ACCESS_KEY ?? "28c72d4b3e1140fa468e367ae472b522";
const secret = process.env.HEALTHBR_R2_SECRET_KEY ?? "2937b2106736e2ba64e24e92f2be4e6c312bba3355586e41ce634b14c1482951";

const inst = await DuckDBInstance.create();
const c = await inst.connect();
await c.run(`INSTALL httpfs; LOAD httpfs;`);
await c.run(`SET s3_endpoint='${endpoint}'; SET s3_access_key_id='${key}'; SET s3_secret_access_key='${secret}';
SET s3_region='auto'; SET s3_url_style='path'; SET s3_use_ssl=true;`);

const glob = `s3://healthbr-data/sih/rd/ano=${ano}/mes=*/uf=${uf}/part-0.parquet`;
const t0 = Date.now();
const r = await c.runAndReadAll(`
  SELECT ano, mes, uf, DT_INTER[1:4] AS ano_inter, DT_INTER[5:6] AS mes_inter, count(*)::BIGINT AS n
  FROM read_parquet('${glob}', hive_partitioning = true, union_by_name = true)
  GROUP BY ALL ORDER BY ALL`);
const rows = r.getRowObjectsJS().map((x) => ({ ...x, n: Number(x.n) }));
const total = rows.reduce((s, x) => s + x.n, 0);
if (out) {
  const csv = ["ano_cmpt,mes_cmpt,uf,ano_inter,mes_inter,n",
    ...rows.map((x) => [x.ano, x.mes, x.uf, x.ano_inter, x.mes_inter, x.n].join(","))].join("\n");
  writeFileSync(out, csv);
}
console.log(`${ano}${uf !== "*" ? "/" + uf : ""}: ${rows.length} linhas agregadas, ${total} internações, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
