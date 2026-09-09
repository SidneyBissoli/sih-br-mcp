# PLAN-005 — Série ICSAP pré-agregada no produtor (`sih:serie-pre-agregada`)

Decisão do usuário em 09/09/2026 (41ª sessão): opção (b) do item do TAREFAS —
pré-agregar no produtor (healthbr-data), não subir de instância. Este plano
antecede o código, pela regra dos itens de pipeline.

## 1. Problema

Com a memória resolvida (0.13.1, consulta ano a ano — CONTEXT decisão 30), a
série ICSAP de 34 anos pela borda leva 310 s no container `basic` (1/4 vCPU)
e a frio a conexão cai antes da resposta. O custo dominante não é o numerador:
é o denominador, que refaz a cada consulta o DISTINCT dos estratos (~700 mil
por ano) sobre cubos de 1,3 M linhas/ano.

## 2. Fatos medidos (09/09/2026, cubos DO CANAL, DuckDB threads=1, i7 local)

| Medição | Valor |
| --- | --- |
| Numerador puro, 34 anos, year×uf (sem DISTINCT) | 1,5 s |
| Denominador HOJE (DISTINCT dos estratos), 34 anos | 26,5 s |
| Denominador via arquivos de estratos pré-gravados | 5,9 s |
| Série 34 anos × 27 UFs via RESUMO pré-agregado | 0,1 s |
| Gerar os 34 arquivos de estratos | 76 s |
| Gerar o resumo (34 anos × 2 universos) | 97 s |
| Tamanho: estratos (34 arquivos, ZSTD) | ~56 MB (2,5 MB/ano recente) |
| Tamanho: resumo (UM arquivo, todos os anos) | 295 KB |

Validação numérica: RR/2023 universo csapaih pelo resumo = 24,70 %
(9.649/39.058) — byte a byte com a produção (conector provado na 41ª);
1992 nacional universo all = 28,18 % (4.413.096/15.659.152).

Na borda (extrapolando pelo fator ~11× medido entre local e `basic`): resumo
≈ 1–2 s; caminho fino com estratos ≈ 60–90 s; hoje 310 s.

## 3. Desenho

Dois artefatos novos por derivação — funções puras dos cubos publicados, sem
tocar o FTP nem os microdados:

- **`sih_icsap_resumo.parquet`** (um arquivo, todos os anos): grão
  `universe × year × uf × cid_revision × csap_group`, com `n_icsap`,
  `total_days`, `total_value` (DECIMAL 18,2), `deaths` e `n_total` (o
  denominador do `universe × year × uf × cid_revision`, repetido nas linhas do
  grupo; o consumidor soma sobre os DISTINCT). Os dois universos (`csapaih`,
  `all`) já computados. 295 KB — o servidor baixa em milissegundos e a série
  longa deixa de depender dos cubos, inclusive a frio.
- **`sih_icsap_estratos_YYYY.parquet`** (por ano): um registro por estrato
  (`year, uf, municipality_code, cid_revision, sex, age, race, exclusion,
  n_total`) — o resultado do DISTINCT, gravado uma vez. Serve de denominador
  para QUALQUER filtro/agrupamento fino (município, sexo, idade, raça),
  eliminando o DISTINCT da consulta.

Roteamento no consumidor (`queryIcsapAggregate`):
1. filtros ⊆ {years, ufs, csapGroups} e groupBy ⊆ {year, uf, csap_group,
   cid_revision} → **resumo** (milissegundos);
2. senão → caminho ano a ano atual, com o denominador lido dos **estratos**
   quando o ano os tem; sem eles, DISTINCT como hoje (fallback integral —
   cache misto e fixtures continuam funcionando; golden numérico intocado).

Frescor ([[verificacao-deriva-da-fonte]]): o bloco do manifesto grava, por
ano, o sha256 do cubo-fonte usado na derivação. Consumidor e `tables:check`
comparam com o sha do bloco `years`; divergiu = resumo/estratos velhos → cai
no caminho lento daquele ano (correção sempre vence velocidade).

## 4. Fases

**F1 — produtor (healthbr-data).**
`scripts/pipeline/sih-cubos/derive-icsap-summary.mjs` (Node +
`@duckdb/node-api`, já dependência do pipeline): baixa os cubos do canal
conforme o manifesto, deriva os dois artefatos com ORDER BY total
(determinismo — [[arrow-atributos-r-no-parquet]] não se aplica, mas a lição
do GROUP BY sem ORDER BY sim), `--selftest` com mini-cubo embutido
(equivalência derivado × recomputado). `cubes-manifest.mjs` ganha
`--summary <dir>` → bloco `icsap_summary` (arquivos + sha256 + `built_at` +
`derived_from` por ano), `manifest_version` 1.3.0. `publish-cubes.sh` ganha a
5ª posição (pasta do resumo). Workflow novo `build-sih-summary.yml`
(workflow_dispatch, padrão do build-sih-population.yml; secrets R2 já
existem). Regra operacional: re-rodar após todo rebuild de cubos (anotada no
workflow e no README do pipeline; encadeamento automático fica de fora).

**F2 — consumidor (sih-br-mcp 0.14.0).** `cache.ts` baixa resumo (e estratos
dos anos pedidos) quando o manifesto os anuncia, com sha e frescor;
`db/duckdb.ts` faz o roteamento acima; equivalência provada contra o caminho
atual nos mesmos 7 cenários da 0.13.1 + cenários de roteamento; golden e
smoke intocados.

**F3 — deploy + prova na borda.** `wrangler deploy`; medir: série 34 anos por
UF a quente (alvo < 5 s) e A FRIO (alvo < 20 s, só manifesto + resumo);
consulta fina multi-ano com estratos (alvo < 100 s). Conector do claude.ai já
existe — sem novo teste de chat (limite de uso do usuário); prova por sonda
HTTP.

## 5. Riscos

- Resumo fora de sincronia com cubos após rebuild → coberto pelo
  `derived_from` (sha por ano) + fallback por ano no consumidor.
- Grão do resumo não cobre um filtro novo no futuro (ex.: faixa etária no
  trends) → o roteamento é conservador: qualquer coisa fora do grão cai no
  caminho fino; o resumo só acelera o que ele representa exatamente.
- `value` como DOUBLE no resumo quebraria o determinismo → gravar DECIMAL(18,2)
  na derivação (mesma lição do funil, docs do 0.9.0).
- Dois universos duplicam o resumo → 295 KB no total; irrelevante.

## 6. Fora de escopo

Encadeamento automático rebuild→derive (fica manual com regra escrita);
pré-agregação por município (grão explode; o caminho fino cobre); instância
maior (opção (a), descartada pelo usuário).

## 7. Execução (09/09/2026, mesma sessão — as fases todas)

**F1 produtor:** healthbr-data PR #5 mesclado; `build-sih-summary.yml` run
34382683131 publicou resumo (276.347 B), 34 estratos e sidecar; manifesto
1.3.0 no ar com `derived_from` batendo nos 34 anos.

**F2 consumidor:** sih 0.14.0 — roteamento + estratos + pulo do download de
cubos quando o resumo cobre; equivalência byte a byte em 10 cenários na
fixture E nos 34 cubos do canal; golden só citação.

**F3 medições pela borda (deploy 0a561234):**

| Medição | 0.13.1 | 0.14.0 |
| --- | --- | --- |
| Série 34 anos, A FRIO (dormindo + disco vazio) | conexão caía ~322 s | **6,4 s** (4,8 cold start + 1,1 consulta) |
| Série 34 anos, a quente | 310 s | **1,1 s** |
| RR/2023 (um ano, uma UF) | 25,5 s* | 0,9 s |
| Fina (2 anos, sexo F, por UF), a frio | — | 31 s (baixa os 2 cubos) |

\* 25,5 s era a janela 2024–2025; um ano quente na 0.13.1 ficava na casa de
segundos com cubo no disco.

Alvos do §4 cumpridos com folga (quente < 5 s: 1,1 s; frio < 20 s: 6,4 s;
fina < 100 s: 31 s). Células de 1992 e 2025 conferidas contra a 0.13.1:
idênticas. Sobra deliberada: encadeamento rebuild→derive segue manual (§6).
