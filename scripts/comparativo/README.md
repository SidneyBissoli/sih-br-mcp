# Comparativo: a mesma pergunta por três caminhos

Scripts da medição de 02/11/2026 que sustenta a página
<https://sih.sidneybissoli.com/vs-microdatasus-pysus> (`worker/src/comparativo.ts`, números em
`MEDIDO`). A pergunta: internações por pneumonia (CID-10 J12–J18) de **moradores** do Espírito
Santo com **data de internação** em 2024 — o que exige as competências 2024-01 a 2025-04 dos
arquivos RD das 27 UFs (432 arquivos), porque o DATASUS publica por UF do hospital e por mês de
faturamento.

| Script | O que mede | Como rodar |
| --- | --- | --- |
| `sih_borda.mjs` | a pergunta no endpoint público do sih-br-mcp (tempo, total, bytes) | `node scripts/comparativo/sih_borda.mjs` (da raiz, depois de `npm ci`) |
| `replica-microdatasus.R` | a mesma pergunta pelo microdado, com microdatasus, arquivo a arquivo | `Rscript scripts/comparativo/replica-microdatasus.R <pasta-de-saída>` (~40 min) |
| `replica_pysus.py` | a mesma pergunta com PySUS (`group="RD"`), arquivo a arquivo | Linux, Python 3.13, `pysus==2.11.7`: `python replica_pysus.py <pasta-de-saída>` |
| `pysus_arquivos_sem_grupo.py` | quantos arquivos o catálogo do PySUS deixa sem grupo, e quantas pneumonias moram neles | depois do microdatasus: `python pysus_arquivos_sem_grupo.py <saída>/md-log.csv` |
| `volumes.mjs` | volumes publicados: microdado bruto do espelho e canal de cubos | `node scripts/comparativo/volumes.mjs` |

Resultado de 02/11/2026: sih-br-mcp 1.8.1 e microdatasus 3.0.0 deram **13.305 internações e
1.250 óbitos**, iguais grupo a grupo. PySUS 2.11.7 com `group="RD"` deixou de ver 87 dos 432
arquivos (o catálogo dele traz 4.526 dos 10.946 arquivos RD sem grupo); no Windows, as chamadas
do SIH voltaram vazias.

Os números envelhecem: o DATASUS reedita arquivos e o espelho é ressincronizado. Para atualizar a
página, rode de novo e troque `MEDIDO` — o `worker/tests/comparativo.test.ts` reprova o que não
bater.
