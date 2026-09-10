# PLAN-006 — Cubo de causas pré-agregado (`sih:causas-pre-agregada`)

Combinado com o usuário em 10/09/2026, ao fim da avaliação de fragilidade: os
itens 1 a 3 daquela avaliação saíram na 0.14.2 (CONTEXT decisão 33) e este
ficou para plano à parte, no padrão do PLAN-005. Escrito ANTES do código,
pela regra dos itens de pipeline.

## 1. Problema

O cubo de causas é o último caminho caro do servidor remoto. Ele responde
"quantas internações", "quanto o SUS gastou", "quais as principais causas" e
"qual a taxa por 100 mil" — as perguntas mais naturais que um usuário faz — e
pesa 22 vezes mais que tudo o que já foi otimizado:

| Cubo | 34 anos | Já tem atalho? |
| --- | --- | --- |
| Séries | 1,2 MB | é o próprio atalho (0.14.2) |
| ICSAP | 389 MB | resumo de 276 KB (PLAN-005) |
| Causas | **1.253 MB** | nenhum |

A 0.14.2 aliviou parte disso roteando `compare_regions` e
`get_hospitalization_rates` para o cubo de séries quando o recorte cabe. Não
resolve `get_hospitalizations`, que devolve dias de internação e valor —
colunas que o cubo de séries não tem — nem qualquer recorte por sexo, idade ou
raça.

## 2. Fatos medidos (09-10/09/2026, `data/` local com 34 anos, DuckDB)

Grãos candidatos, todos com as quatro medidas (`n`, `days`, `value`,
`deaths`) e todos derivados dos cubos publicados:

| Grão | Linhas | Tamanho | Derivação |
| --- | --- | --- | --- |
| **A (grosso)** uf, capítulo, revisão, `is_csap`, `exclusion` | 34.733 | **0,4 MB** | 3 s |
| **B (fino)** A + sexo, faixa etária quinquenal, raça | 8.285.096 | **55,9 MB** | 42 s |
| C (rejeitado) B + categoria CID de 3 dígitos | 54.264.396 | 333,1 MB | 694 s |

Por ano, no grão B: 1995 custa 0,8 MB contra 22,8 MB do cubo (28 vezes menor).

Velocidade da mesma pergunta ("internações e gasto por ano, 34 anos"), com
uma thread, como no container:

| Fonte | Tempo |
| --- | --- |
| Resumo grão A | 0,01 s |
| Cubos de causas | 12,62 s |

Cobertura sobre as chamadas reais que o golden exercita nas três ferramentas
de causas: **11 de 13** roteariam (8 no grão A, 3 no grão B). As duas que
sobram são agrupamento por grupo CSAP e um recorte etário de 0 a 17 anos, que
não cai em fronteira quinquenal.

## 3. Decisões que este plano toma

**Os dois grãos, não um.** O grão A cabe inteiro num arquivo de 0,4 MB e
responde sozinho 8 das 13 chamadas, inclusive a série longa de gasto. O grão
B é 140 vezes maior e serve os recortes demográficos. Publicar só o B faria
toda pergunta simples pagar 56 MB; publicar só o A deixaria sexo, idade e
raça no cubo pesado. É a mesma divisão que o PLAN-005 já provou: um resumo
único e pequeno, mais um artefato por ano para o caso fino.

**A num arquivo só, B por ano.** Espelha `sih_icsap_resumo.parquet` e
`sih_icsap_estratos_YYYY.parquet`. Uma pergunta de dois anos no grão B baixa
cerca de 3 MB em vez de 110 MB.

**Sem a categoria CID de 3 dígitos.** O grão C custaria 333 MB e quase 12
minutos de derivação, para servir um agrupamento que a ferramenta oferece mas
que ninguém pede em série longa. Fica no cubo pesado, junto com mês,
município, idade ano a ano e grupo CSAP.

**No workflow que já existe.** `build-sih-summary.yml` ganha esta derivação
em vez de nascer um workflow novo: os dois resumos saem da mesma leitura dos
cubos, escrevem no mesmo manifesto e devem subir juntos, senão um rebuild
deixa um fresco e outro velho.

## 4. Desenho

Três artefatos novos, publicados em `sih/cubos/` e assinados no bloco
`causas_summary` do manifesto (versão **1.4.0**):

- **`sih_causas_resumo.parquet`** (grão A, todos os anos, 0,4 MB).
- **`sih_causas_estratos_YYYY.parquet`** (grão B, por ano).
- **`causas_summary_provenance.json`** com `derived_from`: o SHA-256 do cubo
  de causas de cada ano, o mesmo contrato de frescor do PLAN-005. Ano cujo
  cubo publicado não é o da derivação não usa o resumo.

Roteamento no consumidor, conservador como o do ICSAP:

1. Recorte dentro do grão A e anos frescos, e nenhum filtro demográfico, vai
   ao resumo A.
2. Recorte que pede sexo, raça ou faixa etária alinhada vai aos estratos B
   dos anos pedidos.
3. Qualquer outra coisa (mês, município, idade livre, categoria de 3 dígitos,
   grupo CSAP) segue no cubo de causas, como hoje.

**A regra da idade merece cuidado.** O grão B agrupa idade em faixas
quinquenais, então um recorte só é atendível se começar em múltiplo de 5 e
terminar em 4 ou 9, ou for 80 ou mais. Não é limitação nova no produto: o
arquivo de população de 1991 a 1999 já tem exatamente essa restrição e ela já
está descrita na ferramenta de taxas. O roteador recusa o que não alinha, e a
pergunta cai no caminho pesado com o número certo.

## 5. Fases

**F1 — produtor.** `derive-icsap-summary.mjs` vira o motor dos dois resumos
(ou ganha um irmão que compartilha download, verificação de SHA e escrita do
sidecar): não faz sentido duplicar a máquina de baixar cubo conferindo hash.
`cubes-manifest.mjs` ganha `--causas-summary`, o bloco `causas_summary` e a
mesma recusa por frescor. `publish-cubes.sh` ganha a sexta posição.
`build-sih-summary.yml` passa a derivar e publicar os dois.
**Saída:** manifesto 1.4.0 no canal com os dois blocos frescos nos 34 anos.

**F2 — consumidor.** `cache.ts` baixa resumo A (sempre que a ferramenta é de
causas) e estratos B dos anos pedidos; `db/duckdb.ts` roteia; `tools.ts`
mapeia o tipo de cubo por chamada, como já faz. Prova nova, no CI, no molde
de `series-routing-equivalence.mjs`: resposta idêntica ao cubo de causas em
cada recorte que roteia, e recusa dos que não cabem, incluindo o caso da
idade não alinhada.
**Saída:** golden byte a byte; equivalência verde na fixture e nos 34 anos.

**F3 — deploy e prova na borda.** Medir, com o container frio: gasto por ano
na série de 34 anos (alvo abaixo de 10 s), principais capítulos na série
longa, e uma pergunta demográfica de poucos anos. Comparar cada número com a
resposta da versão anterior antes de fechar.

## 6. Riscos

- **Resumo velho depois de um rebuild.** Coberto pelo `derived_from` por ano
  mais a recusa no manifesto, igual ao PLAN-005. A regra operacional de rodar
  o workflow após todo rebuild passa a valer para os dois resumos, o que é um
  argumento a mais para mantê-los no mesmo workflow.
- **Somar valor entre moedas.** O grão A carrega `value` agregado por ano, o
  que torna mais fácil somar 1992 com 2025 sem perceber que um está em
  cruzeiros. A nota de era já avisa, e depois da 0.14.2 ela chega junto com a
  resposta. Vale reforçar a nota quando a consulta cruzar a fronteira da
  moeda, e isso entra na F2.
- **Grão que não cobre uma pergunta futura.** O roteamento é conservador por
  desenho: o que não cabe exatamente cai no caminho pesado. O risco é
  desempenho, nunca número errado.
- **`value` como número de ponto flutuante.** Gravar como decimal com duas
  casas na derivação, como no PLAN-005, senão a soma deixa de ser
  determinística.

## 7. Fora de escopo

Categoria CID de 3 dígitos, mês, município, idade ano a ano e grupo CSAP no
resumo (o grão C mede o custo de tentar). Encadeamento automático entre o
rebuild dos cubos e a derivação, que segue manual com regra escrita. Instância
maior, já descartada pelo usuário.

## 8. Execução (2026-09-10, 42ª sessão)

### O que o canal ganhou (F1)

Produtor em `healthbr-data/scripts/pipeline/sih-cubos/`: `derive-causas-summary.mjs`
novo, `summary-lib.mjs` com a máquina de download compartilhada pelos dois
derivadores, `cubes-manifest.mjs` com `--causas-summary` e o bloco
`causas_summary` (manifesto **1.4.0**), `publish-cubes.sh` com a 6ª posição, e
`build-sih-summary.yml` derivando e publicando os DOIS resumos no mesmo run.

Medido nos 34 anos do canal, e não no `data/` local — que estava defasado (só
1992–1997 tinham `cid_revision` e `exclusion`), o que explica a diferença para
as estimativas do §2:

| Grão | Linhas | Tamanho | §2 estimava |
| --- | --- | --- | --- |
| A (um arquivo, 1992–2025) | 47.790 | **0,57 MB** | 34.733 / 0,4 MB |
| B (34 arquivos) | ~2,6 M | **18,8 MB** | 8,3 M / 55,9 MB |
| cubos de causas | — | 1.252,9 MB | 1.253 MB |

Derivação inteira, incluindo baixar 1,25 GB do canal: **48,7 s**.

Velocidade da pergunta do §2, com uma thread: **0,01 s pelo grão A contra
5,50 s pelos cubos**, resposta idêntica. (O §2 media 12,62 s no `data/` local;
os cubos do canal, em ZSTD, leem mais rápido.)

### O que o servidor ganhou (F2)

`causasRoute()` em `src/db/duckdb.ts` decide a fonte e `causasSummaryCoversCall()`
em `src/tools.ts` é o espelho no nível dos ARGUMENTOS — é lá que se decide
baixar 1,25 GB ou 569 KB. `seriesFitsCall` tem precedência: o cubo leve de
séries (1,2 MB) é mais barato que o grão A. `cache.ts` ganhou
`ensureCausasSummary` e `ensureCausasEstratosYears`, e a máquina de frescor
passou a ser uma só, parametrizada pelo bloco e pelo cubo-fonte.

A regra da idade não precisou de código novo: `aggregatedAgeGroupsFor()`, que já
decidia o recorte da taxa antes de 2000, decide também esta rota.

Prova: `scripts/causas-routing-equivalence.mjs` (`npm run equiv:causas`, no CI)
exige resposta byte a byte igual à do cubo em **24 cenários** e confere **21
decisões de rota** — verde na fixture de 2023 e nos **34 anos do canal**. Golden
inalterado exceto a versão na citação.

**O risco do §6 virou código.** O grão A torna trivial somar 1992 com 2025 sem
perceber que um está em cruzeiro: a nota de era passa a dizer explicitamente
quando a consulta CRUZA a fronteira da moeda e que o `total_value` do `summary`
não tem significado econômico. Medido: 1992 + 2025 devolve R$ 18,5 trilhões.

### Cobertura real

As 13 chamadas do golden nas três ferramentas de causas roteiam como o §2
previa. O que continua no cubo, por desenho: mês, categoria CID de 3 dígitos,
grupo CSAP, idade simples agrupada e recorte etário que não alinha nas faixas
quinquenais.
