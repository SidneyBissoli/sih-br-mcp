# SIH-BR-MCP: Contexto do Projeto

> **Este arquivo resume as decisões tomadas no planejamento e orienta o Claude Code sobre o estado atual e próximos passos.**

## Objetivo

Desenvolver um **MCP Server** para análise de dados do Sistema de Informações Hospitalares do SUS (SIH-SUS), com foco em **Internações por Condições Sensíveis à Atenção Primária (ICSAP)**.

---

## Progresso do Desenvolvimento

### Passo 1 (Planejamento) ✅
### Passo 2 (Estrutura e Scripts R) ✅
### Passo 3 (Geração de Dados de Teste) ✅
### Passo 4 (Ferramentas MCP em TypeScript) ✅
- 12 ferramentas implementadas (todas)

### Passo 5 (Dados Populacionais) ✅
- [x] Script R `build-population.R` criado e funcional
- [x] `pop_municipios.parquet` gerado (1991-2024, 27 UFs, 6.326.761 registros)
- [x] `pop_uf.parquet` gerado (2000-2024, 27 UFs, 117.450 registros)
- [x] `pop_uf_agregado.parquet` gerado (1991-1999, derivado dos municípios)

### Passo 6 (Ferramentas Finais) ✅
- [x] `get_hospitalization_rates` implementada (taxa por 100 mil hab, anos 2000-2024)
- [x] `compare_icsap_trends` implementada (tendências com taxa, regressão linear)
- [x] Validação: erro se ano < 2000 (sem dados populacionais UF)
- [x] Build sem erros, testes de população passando

---

## Decisões Arquiteturais

1. **Idade simples** nos cubos de internação (inteiro 0-100+)
2. **Faixa etária** nos cubos de população municipal (limitação da fonte)
3. **Idade simples** nas projeções por UF (quando disponível)
4. **Grupos CSAP** como string ("g01"-"g19")
5. **Capítulos CID** como inteiro (1-22)
6. **População incluída no MCP** (não depende de outro MCP)
7. **Cliente DuckDB: `@duckdb/node-api`** ("Node Neo", cliente oficial atual), desde 2026-09-05 — o binding legado `duckdb` pinava `node-gyp ^9` em runtime e arrastava tar/cacache/glob antigos para o lock (60 dos 72 alertas do Dependabot de 09/2026); o Neo tem binário pré-compilado por plataforma e nenhum toolchain nativo na árvore. Só `src/db/duckdb.ts` toca o cliente, pelo funil `query()`, que lê com `getRowObjectsJS()` e converte bigint. Plano e medições: `docs/plan-002-migracao-duckdb-node-api.md`
8. **Ordem das linhas garantida** nas consultas agrupadas (`buildOrderBy` no funil, 2026-09-05): toda coluna de agrupamento não ordenada pelo chamador entra como desempate — sem isso, duas chamadas iguais devolviam rankings diferentes em empate e subconjuntos diferentes com `limit`
9. **Gate do CI: smoke + golden pelo stdio** (`scripts/smoke-stdio.mjs`, `scripts/golden-tools.mjs`) sobre a fixture versionada em `tests/fixtures/sih` — superfície e valores das 12 ferramentas byte a byte contra `baselines/`; não é suíte (ver `campanha:contrato-vitest` no portfolio-monitor)
10. **Origem dos cubos SIH: healthbr-data, não o FTP** (2026-09-05). `scripts/build-aggregations.R` v2 lê as partições `sih/rd/ano=AAAA/mes=MM/uf=XX/` do R2 público do healthbr-data (Parquet 1:1 do `.dbc`, colunas cruas como string, projetando só as 10 colunas que os cubos usam — 2023/RR são 45.354 linhas em ~13 s) em vez de baixar o `.dbc` via `microdatasus::fetch_datasus`. Motivo além do volume: `process_sih()` trocava os códigos de SEXO, COD_IDADE e MORTE por rótulos e convertia DT_INTER para `Date`, e o script comparava com códigos — o cubo antigo saiu com `sex = "I"` em todas as linhas, `age` nulo, `deaths = 0` e `month` só com `-1`/`0`. O cubo novo tem os mesmos n, dias, valor, raça e CSAP, e sexo, idade, óbitos e mês corretos. `year`/`month` vêm de DT_INTER (data da internação). **Desde o build v2.2.0 (2026-09-05) o script lê o espelho pelo pacote healthbR** — `healthbR::sih_status()` para saber quais partições existem e de que `.dbc` vieram (URL, MD5, tamanho, SHA-256 do Parquet, versão e commit do pipeline) e `healthbR::sih_data(source = "r2", lazy = TRUE)` para ler as 10 colunas projetadas — e não tem mais código S3 nem token próprio (viviam duplicados no script e no pacote). Cada partição lida é conferida contra a contagem do manifesto. `retrieved_at` do sidecar passou a ser o `processing_timestamp` do manifesto, igual ao segundo ao `download_date` do rodapé do Parquet que o script lia antes; o campo `download_date` saiu do sidecar (opcional no tipo TS). Verificado regenerando 2023/RR: cubos idênticos, golden e smoke verdes sem regravar baseline.
10a. **Cubo por ANO DE INTERNAÇÃO, janela de 4 meses** (2026-09-05, build v2.1.0, `MESES_SEGUINTES <- 4L`). O cubo do ano Y lê as competências Y-01..Y-12 e (Y+1)-01..04 e descarta internações de outros anos. Decidido nos dados, não em hipótese: `docs/analise-001-janela-competencia.md` mede, em 131,8 milhões de AIH (competências 2016-01 a 2026-06, 27 UFs), que 4 meses fecham 99,7–99,9% das internações do ano (dezembro 99,3–99,7%), que o 5º e o 6º mês somam 0,04 ponto, e que a cauda restante (0,06–0,19% depois de +12) é reapresentação difusa em GO, RJ e SP que nenhuma janela recupera. Consequências: `year` é sempre o ano do arquivo e `month` vai de 1 a 12 sem queda artificial no fim do ano; o cubo de Y FECHA quando (Y+1)-04 é publicada (partições posteriores não o alteram; só reedição dentro da janela justifica rebuild — regra para `sih:cubos-frescor`); janela incompleta fica marcada no sidecar (`window.complete = false`) e no `data_vintage` ("janela INCOMPLETA"). 2023/RR: 16 partições, 59.141 AIH lidas, 10.661 de outros anos descartadas, 48.480 internações de 2023 (antes: 45.354 AIH de competência 2023, com 5.884 de 2022 e sem 9.010 faturadas em 2024). Scripts da evidência: `scripts/lag-competencia.mjs` (DuckDB sobre o R2) e `scripts/lag-competencia-analise.py`.
11. **Sidecar de proveniência ao lado de cada cubo** (`data/sih_provenance_<ano>.json`, versionado; cópia na fixture). Gravado pelo script R a partir do rodapé `healthbr` de cada Parquet e do manifesto público (`https://pub-99d9e1a3f5c542178d04efbddf1bba97.r2.dev/sih/rd/manifest.json`): URL do `.dbc` no FTP, MD5 e tamanho da origem, data de download no espelho, SHA-256 do Parquet, contagens, versão do script, R e arrow. É o registro de SAFRA (spec-001 §5): `retrieved_at` do bloco de proveniência = maior data de download dos `.dbc` usados, não o instante da chamada — por isso o golden pode gravar o bloco. Vigiar deriva (o MS reedita arquivos): comparar `source_hash_md5`/`source_size_bytes` do sidecar com o manifesto do espelho — a checagem existe desde 0.5.0 (decisão 13); o rebuild automático ainda não (`sih:cubos-frescor` (b) no portfolio-monitor).
12. **Bloco de proveniência em toda resposta** (`src/provenance.ts`, contrato `@sbissoli/mcp-provenance` v1, modo concise, namespace `br.sbissoli.sih`). A fonte no topo é o Ministério da Saúde/DATASUS; o healthbr-data aparece em `citation`, `derivation_note` e `license` como redistribuição (CC-BY-4.0), nunca como fonte. Ferramentas de referência citam a Portaria 221/2008 ou a CID-10; `get_hospitalization_rates` leva um segundo bloco do IBGE (SIDRA 7358); as de ICSAP levam SIH + Portaria. O texto da resposta é o próprio `structuredContent` (com `provenance` e `attribution`); não há rodapé em parte separada porque smoke e golden juntam as partes e fazem `JSON.parse`. Os scripts de smoke/golden leem o ano do campo estrutural `years` — o regex sobre o texto inteiro pegaria o `2026` da citação.
13. **Frescor dos cubos frente ao espelho, checado na inicialização sem bloquear** (`src/freshness.ts`, 2026-09-05, 0.5.0 — item (a) de `sih:cubos-frescor`). O manifesto público do healthbr-data tem 10,4 MB, o r2.dev não comprime e o `sync-status.json` da raiz do bucket tem 10,7 MB (todos os datasets; não é versão enxuta) — então a checagem é em dois passos: (1) `GET` com `Range: bytes=0-511` (R2 aceita; o `last_updated` está nos primeiros 256 bytes, ~0,5 s) e, se for igual ao `distributor.manifest_last_updated` de todos os sidecars, os cubos estão em dia; (2) só se o manifesto mudou, baixa o arquivo inteiro (~1 s, 29 MB de heap) e compara partição a partição o que cada cubo usou — MD5/tamanho do `.dbc` diferente = reedição do MS (`reedited`), SHA-256 do Parquet diferente = pipeline regenerou (`reprocessed`), partição sumida (`removed`) — e procura competência da janela publicada depois do build (`new_in_window`, só importa para cubo com `window.complete = false`, porque o cubo de Y fecha quando (Y+1)-04 sai). Timeouts 3 s / 12 s; `fire-and-forget` no `main()`; nova checagem em segundo plano quando a última tem mais de 6 h. Veredito (`current` | `stale` | `unknown` | `pending` | `disabled`) sai em `get_available_years.freshness` e, quando `stale`, entra no `data_vintage` do bloco concise ("[ATRÁS do espelho healthbr-data: N partições reeditadas pelo MS (...)]") e em `notices`; `unknown` só em `notices` (o concise não mostra notices — é a única chave visível, por isso o vintage). `SIH_FRESHNESS_CHECK=off` desliga (smoke e golden usam: o baseline não pode depender do portal); a comparação é testada offline por `npm run freshness:selftest` sobre `tests/fixtures/sih/manifest-excerpt.json` (trecho do manifesto real restrito às 16 partições do sidecar; regravar com `npm run freshness:excerpt`). `npm run freshness` mostra o veredito ao vivo (sai 0/3/2 para current/stale/unknown). Isto só AVISA: rebuild automático e cache de cubos são os itens (b) e (c).
14. **Rebuild automático dos cubos atrás do espelho** (`.github/workflows/rebuild-cubes.yml`, 2026-09-06, 0.6.0 — item (b) de `sih:cubos-frescor`; plano e medições em `docs/plan-003-rebuild-cubos.md`). Gatilho em duas camadas, a barata primeiro: `schedule` terça 06:00 UTC (depois do sync-check de segunda do healthbr-data + ~20 h de manutenção) e `repository_dispatch` `healthbr-sih-updated` que o sync-check do healthbr-data envia no fim da manutenção (PR #2 lá; PAT `SIH_DISPATCH_PAT` fine-grained, só Contents no sih) — o dispatch é latência, não decisão: o job `decide` roda `npm run freshness -- --out` e reconstrói só os cubos `behind` (`force` reconstrói todos; `years`+`ufs` cria cubo novo; `unknown` fica VERMELHO, sem rebuild silencioso). O runner tem R (`r-lib/actions/setup-r` com PPPM) e instala `SidneyBissoli/healthbR` do GitHub — a 0.3.1 do CRAN não tem `sih_status()` — e lê o espelho sem segredo nenhum (as credenciais de leitura do R2 são públicas, vivem no pacote). `scripts/rebuild-cubes.R` é a CLI do builder: anos por argumento, UFs de arquivo do sidecar do ano (escopo explícito, sobrevive ao rebuild), exit 1 se um ano falhar (`build_data()` engole). Três gates, porque o golden do CI é da fixture e não vê `data/`: contagem lida = manifesto (já existia); `scripts/cube-delta.mjs` sidecar novo × anterior (reprova partição perdida sem `removed` no espelho, queda > 1% sem retirada, janela regredida, escopo mudado sem pedir; `npm run cube:delta:selftest` no CI); smoke stdio sobre os cubos novos. Publica release `cubes-AAAAMMDD-HHMM` (cubos + sidecars + delta, `GITHUB_TOKEN`) e commita os sidecars no master — o sidecar é a memória do frescor. `sih/cubos/` no R2 e cache local ficam para o (c). **Medido antes de decidir escopo** (2023, 5 UFs, 517 mil AIH): build 2.2.0 levava 562 s, dos quais 35 s de R2 e ~525 s de `map_int(cid, extrair_capitulo_cid)` + `Vectorize(classificar_csap)` — ano nacional extrapolado ~5,4 h; build 2.2.1 classifica os CIDs distintos e espalha por `match` (`por_valor_unico()`): 45,7 s, cubos idênticos. De quebra: `uf_map[codigo]` devolvia vetor NOMEADO e o arrow gravava os nomes nos metadados do Parquet — o cubo de causas de 2023/RR tinha 598 KB com 658 KB de metadado `r` (comprimido); com `unname()` ficou em 242 KB, conteúdo idêntico (a fixture não foi trocada: os valores são os mesmos). Cubo nacional continua decisão do usuário; o custo agora é conhecido (~25–30 min de runner, dominado pela leitura do R2).
15. **Cubo NACIONAL de 2023 em produção; builder 2.3.0 agrega por UF de arquivo** (2026-09-06, à tarde, decisão do usuário). Dispatch `years=2023 ufs=all`: o 1º run (34038116890) leu as 432 partições em 1,6 min e o runner MORREU na agregação — 13,3 milhões de internações num único data frame não cabem em 16 GB. Builder 2.3.0: `agregar_lote()` processa uma UF de arquivo por vez e `somar_lotes()` soma os agregados nas chaves de grupo; mesmo cubo (colunas inteiras idênticas, `value` igual ao último ulp — medido ≤ 1,5e-11 em 5 UFs; 2023/RR idêntico), pico de memória do maior lote (SP, ~3,5 milhões). 2º run (34038899306) verde: 20 min de build (≈25 s por lote são abertura do dataset no R2), delta relatou a mudança de escopo pedida (RR → 27 UFs), smoke sobre os cubos novos OK, sidecar commitado (ffbf51f), release `cubes-20260906-1444` (causas 50 MB, ICSAP 11 MB, séries 36 KB). Totais: 17.969.863 AIH lidas, 13.324.364 internações de 2023, 587.630 óbitos, R$ 20,67 bi, 6.085.836 linhas de causas, 1.264.234 de ICSAP. A fixture segue 2023/RR (golden e smoke do CI não mudaram). Anos seguintes: um dispatch cada. O push do sidecar pelo GITHUB_TOKEN não dispara o ci.yml (comportamento do GitHub), e não precisa.

16. **Janela nacional completa 2019–2024 em produção** (2026-09-06, 30ª sessão; ordem do usuário dada no fim da 29ª). Três dispatches `ufs=all`, dois anos por run: 2024+2022 (run 34041938255, 31 min 54 s, release `cubes-20260906-1551`, sidecar 165cd3a), 2021+2020 (run 34045123114, build 34 min 38 s, `cubes-20260906-1655`, 3dc0fd3) e 2019 (run 34047810068, build 13 min 55 s, `cubes-20260906-1725`, 2a8de9f). Internações por ano: 2019 12.287.939 · 2020 10.615.141 · 2021 11.654.999 · 2022 12.454.873 · 2023 13.324.364 · 2024 14.128.150 — 74.465.466 no total, 27 UFs e 432 partições cada, `window.complete = true` em todos. Conferência local por ano: soma de `n` em causas e séries = `records_in_cube` do sidecar, linhas = `*_rows`; `npm run freshness` `current` para os seis; smoke stdio sobre `data/` OK; `get_available_years` lista 2019–2024. **Defeito achado e corrigido no caminho** (7f272c9): o `workflow_dispatch` fixa o commit do disparo, e o run de 2019, enfileirado atrás do de 2020+2021, teve o push do sidecar rejeitado porque o master já tinha andado — o passo de commit agora faz fetch + rebase + push (3 tentativas); o run 4 provou o conserto. **2025 não foi construído**: o espelho tem a janela completa (2026-01..04 publicadas) mas `pop_uf.parquet` para em 2024, então as ferramentas de taxa não teriam denominador — decisão do usuário. **2026 não**: janela incompleta no espelho. Cubos locais somam ~370 MB (causas ~50 MB/ano, ICSAP ~11 MB/ano); `data/*.parquet` continua gitignored e vem da release.

---

## REGRAS PARA DADOS POPULACIONAIS

### Hierarquia de fontes
1. **Primeiro:** Usar dados que o IBGE disponibiliza
2. **Segundo:** Se IBGE não tiver, usar dados que o DATASUS disponibiliza
3. **Nunca:** Criar dados que nem IBGE nem DATASUS disponibilizam

### Proibições absolutas
- ❌ **PROIBIDO interpolar** dados entre anos
- ❌ **PROIBIDO incluir projeções futuras** (após 2024)
- ❌ **PROIBIDO inventar** valores não existentes nas fontes

### Operações permitidas
- ✅ Baixar dados exatamente como estão nas fontes
- ✅ Padronizar formatos (códigos de município, nomes de variáveis)
- ✅ **Agregar municípios para obter UF** (soma simples, não é interpolação)

---

## Estrutura dos Dados Populacionais (GERADOS)

### Arquivo 1: `pop_municipios.parquet` ✅

Dados municipais consolidados de todas as fontes (IBGE via DATASUS).

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (1991-2024) |
| source | string | Fonte: "censo", "contagem", "estimativa" |
| municipality_code | string | Código IBGE 6 dígitos |
| uf | string | Sigla UF |
| sex | string | "M", "F" ou "total" |
| age_group | string | Faixa etária (ex: "0-4", "5-9", ..., "80+") |
| population | int | População |

**Estatísticas:** 6.326.761 registros, 27 UFs, 1991-2024

### Arquivo 2: `pop_uf.parquet` ✅

Projeções/estimativas por UF do IBGE (Revisão 2024), com sexo e idade simples.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (2000-2024) |
| uf | string | Sigla UF |
| sex | string | "M" ou "F" |
| age | int | Idade simples (0-90, onde 90 = 90+) |
| population | int | População |

**Estatísticas:** 117.450 registros, 27 UFs, 2000-2024

### Arquivo 3: `pop_uf_agregado.parquet` ✅

Para anos onde não há projeção UF com idade (antes de 2000), agregado dos dados municipais.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (1991-1999) |
| uf | string | Sigla UF |
| sex | string | "M", "F" ou "total" |
| age_group | string | Faixa etária |
| population | int | População (soma dos municípios) |

---

## Ferramentas MCP

| Ferramenta | Status | Descrição |
|------------|--------|-----------|
| `get_hospitalizations` | ✅ | Contagens de internações |
| `get_hospitalization_trends` | ✅ | Séries temporais |
| `get_hospitalization_rates` | ✅ | Taxas por 100 mil hab (anos 2000-2024) |
| `compare_regions` | ✅ | Comparação entre regiões |
| `get_icsap` | ✅ | Internações ICSAP |
| `get_icsap_indicators` | ✅ | Indicadores ICSAP |
| `compare_icsap_trends` | ✅ | Tendências ICSAP com taxas (anos 2000-2024) |
| `rank_csap_groups` | ✅ | Ranking grupos CSAP |
| `classify_as_csap` | ✅ | Classifica CID como CSAP |
| `list_csap_groups` | ✅ | Lista grupos CSAP |
| `list_cid_chapters` | ✅ | Lista capítulos CID |
| `get_available_years` | ✅ | Anos disponíveis |

**Total:** 12/12 implementadas ✅

---

## Estrutura do Projeto

```
sih-br-mcp/
├── data/
│   ├── sih_causas_2023.parquet      ✅
│   ├── sih_series_2023.parquet      ✅
│   ├── sih_icsap_2023.parquet       ✅
│   ├── pop_municipios.parquet       ✅ NOVO
│   ├── pop_uf.parquet               ✅ NOVO
│   ├── pop_uf_agregado.parquet      ✅ NOVO
│   └── test/
├── scripts/
│   ├── build-aggregations.R         (builder; sem CLI)
│   ├── rebuild-cubes.R              (CLI do builder — é o que o workflow roda)
│   ├── cube-delta.mjs               (gate: sidecar novo × anterior)
│   ├── freshness-check.mjs          (frescor ao vivo / selftest / excerpt)
│   ├── smoke-stdio.mjs, golden-tools.mjs
│   └── build-population.R
├── .github/workflows/
│   ├── ci.yml                       (smoke + golden + selftests sobre a fixture)
│   ├── rebuild-cubes.yml            (rebuild dos cubos atrás do espelho + release)
│   └── publish.yml
├── src/
│   ├── index.ts                     (servidor MCP + 12 ferramentas)
│   ├── db/duckdb.ts                 (queries DuckDB + população)
│   └── utils/                       (age-groups, population)
└── ...
```

---

## Ambiente

- **Sistema:** Windows + PowerShell
- **Projeto:** `C:\dev\mcp\sih-br-mcp`
- **R:** builder (`scripts/build-aggregations.R`, via `scripts/rebuild-cubes.R`): `healthbR` (GitHub main, com `sih_status()`), `arrow`, `dplyr`, `tidyr`, `purrr`, `stringr`, `cli`, `jsonlite`, `here`; população (`scripts/build-population.R`): `sidrar`. Reconstruir um cubo à mão: `Rscript scripts/rebuild-cubes.R --years 2023` (UFs do sidecar) ou `--years 2024 --ufs all`
- **Node:** TypeScript, esbuild, @modelcontextprotocol/sdk

---

## Referências

- **DATASUS População:** http://tabnet.datasus.gov.br/cgi/ibge/popdescr.htm
- **SIDRA IBGE:** https://sidra.ibge.gov.br/
- **Projeções IBGE:** https://www.ibge.gov.br/estatisticas/sociais/populacao/9109-projecao-da-populacao.html
- **Pacote csapAIH:** https://github.com/fulvionedel/csapAIH
- **FTP DATASUS:** ftp://ftp.datasus.gov.br/dissemin/publicos/IBGE/
