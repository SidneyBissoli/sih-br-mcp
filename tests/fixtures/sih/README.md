# Fixture do smoke e do golden stdio

Cópia, sem alteração, dos três cubos de 2023 que `scripts/build-aggregations.R`
gera em `data/` (dados reais, agregados — não há nada sintético aqui), mais o
sidecar de proveniência `sih_provenance_2023.json` que o mesmo script grava ao
lado deles, e os dois cubos de população por UF que
`scripts/build-population.R` gera (`pop_uf.parquet`, idade simples, 2000–2024;
`pop_uf_agregado.parquet`, faixa etária, 1991–1999). Existem porque
`data/*.parquet` é gitignored e o CI parte de um checkout sem dado nenhum; o
servidor é apontado para esta pasta pela variável `SIH_DATA_DIR` (ver
`src/db/duckdb.ts`), que vale para os cubos SIH, para o sidecar e para os
cubos de população.

Os cubos SIH foram gerados em 05/09/2026 com `build_data(years = 2023, ufs =
"RR")`: as 12 partições `sih/rd/ano=2023/mes=MM/uf=RR/` do healthbr-data
(espelho Parquet do FTP do DATASUS), 45.354 internações de competência 2023 em
estabelecimentos de Roraima. A coluna `uf` dos cubos é a UF de residência, por
isso aparecem AL AM AP CE GO MA MG PB RJ RR. O sidecar diz de quais `.dbc`
(URL, MD5, tamanho, data de download no espelho) cada número saiu; é dele que
o servidor tira `retrieved_at` e `data_vintage` do bloco de proveniência — e é
por isso que o bloco é determinístico e cabe no golden.

Quem lê daqui:

- `scripts/smoke-stdio.mjs` — superfície das ferramentas + três chamadas.
- `scripts/golden-tools.mjs` — as doze ferramentas com argumentos fixos,
  comparadas byte a byte com `baselines/golden-tools.json`. Os dois cubos de
  população entraram em 05/09/2026 para que as duas ferramentas de taxa
  (`get_hospitalization_rates`, `compare_icsap_trends`) também fossem
  cobertas pelo golden antes da troca do binding DuckDB (PLAN-002).

Os dois scripts leem o ano a consultar do campo `years` de
`get_available_years`, não do texto inteiro da resposta: o bloco de
proveniência traz outros anos (safra, citação) e um regex sobre o texto pegaria
o maior deles.

Fica de fora `pop_municipios.parquet` (13 MB): é o terceiro degrau da
hierarquia de `getPopulation` e as taxas por UF resolvem em `pop_uf`.

Quando o esquema dos cubos mudar nos scripts R, regenerar `data/` e copiar os
arquivos (cubos e sidecar) de novo — smoke e golden reprovam sozinhos se eles
ficarem para trás.

Semântica que o golden grava e que não é defeito: o arquivo do cubo é o ano de
COMPETÊNCIA da AIH, e `year`/`month` vêm da data de internação (`DT_INTER`).
Por isso `sih_causas_2023.parquet` contém linhas com `year = 2022`
(internações de 2022 com alta em 2023) e poucas linhas em out–dez/2023 (as
altas dessas internações caem em competências de 2024). Até 05/09/2026 o cubo
tinha `month` só com `-1`/`0`, `sex = "I"` em todas as linhas, `age` nulo e
`deaths = 0` — efeito do `process_sih()` do microdatasus sobre um script que
comparava códigos; corrigido ao trocar a origem para o healthbr-data (ver
CONTEXT.md, decisão 10).
