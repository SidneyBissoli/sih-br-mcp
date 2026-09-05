# Fixture do smoke stdio

Cópia, sem alteração, dos três cubos de 2023 que `scripts/build-aggregations.R`
gera em `data/` a partir do SIH-SUS (dados reais, agregados — não há nada
sintético aqui). Existem porque `data/*.parquet` é gitignored e o CI parte de
um checkout sem dado nenhum; o servidor é apontado para esta pasta pela
variável `SIH_DATA_DIR` (ver `src/db/duckdb.ts`).

Quando o esquema dos cubos mudar no script R, regenerar `data/` e copiar os
três arquivos de novo — o smoke reprova sozinho se eles ficarem para trás,
porque as consultas passam a falhar.

Os cubos de população (`pop_*.parquet`, 13 MB) ficam de fora: o smoke não
chama as ferramentas de taxa.
