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
"RR")`: as 16 partições `sih/rd/ano=2023/mes=MM/uf=RR/` e
`ano=2024/mes=01..04/uf=RR/` do healthbr-data (espelho Parquet do FTP do
DATASUS), 59.141 AIH lidas, das quais 48.480 são internações iniciadas em 2023
em estabelecimentos de Roraima (as 10.661 restantes são de 2022 ou 2024 e
ficam de fora — cubo por ano de internação, janela de 4 meses, ver
`docs/analise-001-janela-competencia.md`). A coluna `uf` dos cubos é a UF de
residência, por isso aparecem AL AM AP CE GO MA MG PB RJ RR. O sidecar diz de quais `.dbc`
(URL, MD5, tamanho, data de download no espelho) cada número saiu; é dele que
o servidor tira `retrieved_at` e `data_vintage` do bloco de proveniência — e é
por isso que o bloco é determinístico e cabe no golden. O sidecar aqui é o do
build v2.2.0 (2026-09-05), o primeiro a ler o espelho pelo pacote healthbR
(`sih_status()` + `sih_data(source = "r2", lazy = TRUE)`) em vez de código S3
próprio: os três cubos saíram idênticos aos do build v2.1.0 (comparados linha a
linha), por isso os `.parquet` são os mesmos arquivos e só o sidecar mudou
(`builder.version`, `builder.healthbr_version`, sem `download_date` — o
`retrieved_at` vem do `processing_timestamp` do manifesto, igual ao segundo).

`manifest-excerpt.json` é o trecho do manifesto público do healthbr-data
(`sih/rd/manifest.json`, 10,4 MB) restrito às 16 partições que o sidecar usou,
mais o cabeçalho (`last_updated` etc.). Serve ao autoteste offline da
checagem de frescor (`npm run freshness:selftest`, `src/freshness.ts`):
sidecar vs trecho tem de dar `current`, e uma cópia adulterada do trecho tem
de dar `stale`. Regravar com `npm run freshness:excerpt` sempre que o sidecar
mudar; se o espelho tiver reeditado uma partição de 2023/RR, o autoteste
reprova até o cubo ser regenerado — de propósito.

Quem lê daqui:

- `scripts/smoke-stdio.mjs` — superfície das ferramentas + três chamadas.
- `scripts/freshness-check.mjs --selftest` — sidecar vs `manifest-excerpt.json`.
- `scripts/cube-delta.mjs --selftest` — o sidecar contra si mesmo (delta zero)
  e contra cópias adulteradas (partição perdida, queda > 1%, janela regredida,
  escopo mudado, reedição do MS): é o gate que `rebuild-cubes.yml` aplica a um
  cubo real recém-gerado, provado aqui offline.
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
ficarem para trás. Os `.parquet` daqui são os do build 2.2.0 e carregam nos
metadados do Parquet os nomes que `uf_map[codigo]` deixava na coluna `uf`
(598 KB o de causas); o build 2.2.1 (06/09/2026) tira isso (242 KB) sem mudar
um valor — por isso a fixture não foi trocada. O `builder.version` do
sidecar aqui fica em 2.2.0 até a próxima regeneração de verdade.

Semântica que o golden grava: `year` é sempre 2023 e `month` vai de 1 a 12,
com `year`/`month` vindos da data de internação (`DT_INTER`). Os dois casos
de tendência que pedem 2022 gravam como o servidor trata um ano pedido e
ausente. História: até 05/09/2026 o cubo tinha `month` só com `-1`/`0`,
`sex = "I"` em todas as linhas, `age` nulo e `deaths = 0` — efeito do
`process_sih()` do microdatasus sobre um script que comparava códigos — e,
por ser recortado por competência, trazia internações de 2022 e perdia as de
out–dez/2023 faturadas em 2024. Corrigido ao trocar a origem para o
healthbr-data e adotar a janela de 4 meses (CONTEXT.md, decisões 10 e 10a).
