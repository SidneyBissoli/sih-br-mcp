# Fixture do smoke e do golden stdio

Cópia, sem alteração, dos três cubos de 2023 que `scripts/build-aggregations.R`
gera em `data/` a partir do SIH-SUS (dados reais, agregados — não há nada
sintético aqui), mais os dois cubos de população por UF que
`scripts/build-population.R` gera (`pop_uf.parquet`, idade simples, 2000–2024;
`pop_uf_agregado.parquet`, faixa etária, 1991–1999). Existem porque
`data/*.parquet` é gitignored e o CI parte de um checkout sem dado nenhum; o
servidor é apontado para esta pasta pela variável `SIH_DATA_DIR` (ver
`src/db/duckdb.ts`), que vale tanto para os cubos SIH quanto para os de
população.

Quem lê daqui:

- `scripts/smoke-stdio.mjs` — superfície das ferramentas + três chamadas.
- `scripts/golden-tools.mjs` — as doze ferramentas com argumentos fixos,
  comparadas byte a byte com `baselines/golden-tools.json`. Os dois cubos de
  população entraram em 05/09/2026 para que as duas ferramentas de taxa
  (`get_hospitalization_rates`, `compare_icsap_trends`) também fossem
  cobertas pelo golden antes da troca do binding DuckDB (PLAN-002).

Fica de fora `pop_municipios.parquet` (13 MB): é o terceiro degrau da
hierarquia de `getPopulation` e as taxas por UF resolvem em `pop_uf`.

Quando o esquema dos cubos mudar nos scripts R, regenerar `data/` e copiar os
arquivos de novo — smoke e golden reprovam sozinhos se eles ficarem para trás.

Curiosidade conhecida, não consertada de propósito (ver PLAN-002 §2):
`sih_causas_2023.parquet` contém linhas com `year = 2022`, e a coluna `month`
só tem os valores `-1` e `0` (`year_month` vai de `2022--1` a `2023-00`). É o
que o script R produziu; o golden grava o que o servidor devolve sobre isso.
