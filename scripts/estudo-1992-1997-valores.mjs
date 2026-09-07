// Temporário (estudo 1992–1997): distribuição dos valores de SEXO, COD_IDADE
// e MORTE por ano de competência, para saber se o builder precisa de
// recodificação na era antiga (SEXO.CNV de 1992–97 diz 2,3 = feminino).
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFileSync } from "node:fs";

const [anos, out] = process.argv.slice(2);
const endpoint = "5c499208eebced4e34bd98ffa204f2fb.r2.cloudflarestorage.com";
const inst = await DuckDBInstance.create();
const c = await inst.connect();
await c.run(`INSTALL httpfs; LOAD httpfs;`);
await c.run(`SET s3_endpoint='${endpoint}'; SET s3_access_key_id='28c72d4b3e1140fa468e367ae472b522'; SET s3_secret_access_key='2937b2106736e2ba64e24e92f2be4e6c312bba3355586e41ce634b14c1482951';
SET s3_region='auto'; SET s3_url_style='path'; SET s3_use_ssl=true;`);
const lines = ["ano,campo,valor,n"];
for (const ano of anos.split(",")) {
  const glob = `s3://healthbr-data/sih/rd/ano=${ano}/mes=*/uf=*/part-0.parquet`;
  const t0 = Date.now();
  const r = await c.runAndReadAll(`
    WITH b AS (SELECT CAST(SEXO AS VARCHAR) AS sexo, CAST(COD_IDADE AS VARCHAR) AS cod_idade, CAST(MORTE AS VARCHAR) AS morte,
                      try_cast(CAST(IDADE AS VARCHAR) AS INT) AS idade
               FROM read_parquet('${glob}', hive_partitioning = true, union_by_name = true))
    SELECT 'SEXO' AS campo, sexo AS valor, count(*)::VARCHAR AS n FROM b GROUP BY ALL
    UNION ALL SELECT 'COD_IDADE', cod_idade, count(*)::VARCHAR FROM b GROUP BY ALL
    UNION ALL SELECT 'MORTE', morte, count(*)::VARCHAR FROM b GROUP BY ALL
    UNION ALL SELECT 'IDADE_max_por_cod', cod_idade || ':' || max(idade)::VARCHAR, count(*)::VARCHAR FROM b GROUP BY cod_idade
    ORDER BY 1, 2`);
  for (const x of r.getRowObjectsJS()) lines.push(`${ano},${x.campo},${x.valor ?? ""},${x.n}`);
  console.log(`${ano}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
writeFileSync(out, lines.join("\n"));
