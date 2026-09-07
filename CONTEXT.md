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
17. **2025 em produção; população até o último cubo FECHADO; intervalo de taxas lido do arquivo** (2026-09-06, noite, 30ª sessão; o usuário "não se opôs" ao 2025 e deu o sim para reescrever a regra). Cubo 2025: 14.644.591 internações (o maior ano), 19.487.763 AIH lidas, 27 UFs, janela completa (2026-01..04 no espelho); release `cubes-20260906-2248`, sidecar d165770, builder **2.3.1**. Dois runs com o builder 2.3.0 (34062485932 e 34063289778) foram CANCELADOS pelo runner no meio do cubo ICSAP, sem mensagem — estouro dos 16 GB: o passo rodava com `cubo_causas` (6,5 M linhas) e os 27 lotes de causas ainda na memória; 2024 (14,1 M) passou por margem. 2.3.1 solta o cubo de causas e os lotes antes do ICSAP (d768cd6); build de 2025 em 16,5 min. **População:** a regra "PROIBIDO projeções futuras (após 2024)" virou "até o último ano de cubo FECHADO do SIH" (seção de regras); `build-population.R` ganhou a categoria 49041 (2025) da SIDRA 7358 e `pop_uf.parquet` foi regenerado 2000–2025 (122.364 linhas; 2000–2024 idênticos ao arquivo anterior, conferido por EXCEPT nos dois sentidos). A SIDRA 7358 também serve 2026 (49042) — só entra quando o cubo de 2026 fechar. **Servidor:** `getPopulationYearRange()` (src/db/duckdb.ts) lê min/max de `pop_uf.parquet` uma vez; `get_hospitalization_rates` e `compare_icsap_trends` validam por ele e as descrições deixaram de fixar "2000-2024"; `get_available_years` devolve `population_years`. Baselines regravados só por esse diff. Verificado ao vivo: taxa de 2025 para RR e SP com denominador de 2025 (RR 5.247,79/100 mil). Nota: o CONTEXT dizia "Revisão 2024" para `pop_uf`, mas o script baixa a revisão 2018 (`p/2018`) da tabela 7358 — corrigido o texto acima; migrar para a Projeção 2024 do IBGE é item futuro, não urgente.
18. **Canal público dos cubos + cache local** (2026-09-07, madrugada, 30ª sessão — item (c) de `sih:cubos-frescor`, FECHADO; 0.7.0). Decisões do usuário em 06/09: bucket R2 `healthbr-data`, prefixo **`sih/cubos/`** (não `agregados`: os `sipni/agregados/` são DPNI/CPNI oficiais do DATASUS, redistribuição; os cubos são derivados nossos), domínio próprio **`https://data.sidneybissoli.com/`** ligado pelo usuário ao bucket inteiro (o `r2.dev` segue ativo), token R2 "Object Read & Write" restrito ao bucket criado pelo usuário e gravado como secrets `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` do repositório. **Publicação:** `scripts/cubes-manifest.mjs` gera `sih/cubos/manifest.json` (SHA-256 e tamanho por arquivo, resumo do sidecar por ano; `--verify` confere cada cubo contra o sidecar no DuckDB antes de assinar; anos não recalculados vêm do manifesto anterior); `scripts/publish-cubes.sh` sobe pelo AWS CLI no endpoint S3 do R2 (arquivos primeiro, manifesto por último, `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` porque o R2 recusa o CRC32 do CLI ≥ 2.23) e confere o content-length pelo domínio público; `rebuild-cubes.yml` publica depois da release (sem secrets, avisa e não falha); `publish-cubes.yml` (manual) republica a partir da release mais recente de cada ano — carga inicial dos 7 anos feita no run 34068597202 (416 MB; SHA-256 de um cubo conferido byte a byte pelo domínio). **Consumo:** `src/cache.ts` — o pacote npm NÃO embarca cubo; sem `sih_*.parquet` em `data/`, `getDataDirectory()` passa a usar `~/.cache/sih-br-mcp/cubos/` (`SIH_CACHE_DIR`), e o handler de ferramentas chama `ensureYears()` antes da consulta com os anos lidos dos argumentos (`year`, `years`, `start_year..end_year`; sem ano = série publicada inteira); cada arquivo é baixado para `.part`, conferido por tamanho e SHA-256 do manifesto e só então renomeado; downloads do mesmo ano não se duplicam (mapa em voo); manifesto memoizado 10 min com cópia em disco para quando a rede falha. `get_available_years` ganha `cubes_channel` (anos publicados, origem do manifesto, pasta do cache). `SIH_CUBES_CACHE=off` desliga (smoke e golden usam). Provado: ponta a ponta com `data/` vazio → 2020/RR respondeu em 6,2 s incluindo 51 MB de download; `npm run cache:selftest` (CI) prova offline, com servidor HTTP local, download íntegro aceito, adulterado de mesmo tamanho recusado pelo SHA-256 sem resto no cache, ano fora do canal em `unavailable`, manifesto do disco sem rede. Fora do escopo: apagar/atualizar cubo do cache (o frescor avisa; repor é apagar e chamar de novo) e Cache Rule da Cloudflare para o domínio (hoje `cf-cache-status: DYNAMIC`).
19. **Série histórica 2008–2018 em produção — 18 anos (2008–2025) no canal** (2026-09-07, madrugada, 31ª sessão; ordem do usuário dada no fim da 30ª: primeira das três etapas de "a maior série histórica de SIH no Brasil"; seguem 1998–2007 e o ESTUDO de 1992–1997, só quando ele nomear). Seis dispatches `ufs=all` do rebuild-cubes.yml, dois anos por run, do mais novo ao mais velho, um rodando + um pendente: 2018+2017 (run 34072157623, build 25 min 05 s, release `cubes-20260907-0135`, sidecar eb6aafd), 2016+2015 (34072242152, 25 min 26 s, `cubes-20260907-0201`, e1fbefa), 2014+2013 (34073602482, 21 min 59 s, `cubes-20260907-0223`, 7e7d09f), 2012+2011 (34074925121, 25 min 13 s, `cubes-20260907-0249`, 4bf7631), 2010+2009 (34076243225, 22 min 52 s, `cubes-20260907-0312`, aef9c3c), 2008 (34077618579, 11 min 23 s, `cubes-20260907-0324`, 55833cc) — 2 h 12 min de build no total, builder 2.3.1 sem nenhuma alteração (2008+ tem todas as colunas que o builder usa; conferido em 06/09 lendo partições de SP). Internações por ano: 2008 11.286.218 · 2009 11.337.490 · 2010 11.559.361 · 2011 11.462.401 · 2012 11.286.700 · 2013 11.350.351 · 2014 11.502.252 · 2015 11.450.030 · 2016 11.367.393 · 2017 11.627.877 · 2018 11.953.006 — 126.183.079 no lote (169.392.479 AIH lidas), 215.293.136 internações nos 18 anos; 27 UFs e 432 partições em cada ano, `window.complete = true` em todos. Canal `sih/cubos/`: 18 anos, 1.001 MB (48,6 MB em 2008 a 57,7 MB em 2018; cada run publicou na hora). Conferência por ano ao chegar: `cubes-manifest.mjs --verify` sobre a release baixada (soma de `n` = `records_in_cube`, linhas = sidecar), `content-length` no domínio = tamanho local, manifesto com os anos novos; ao fim: smoke stdio sobre `data/` com 18 cubos OK, `npm run freshness` `current` para os 18, `get_available_years` 2008–2025 com `population_years` 2000–2025, taxa bruta de 2008 pelo stdio com denominador de 2008 (RR 5.961,37/100 mil; SP 5.690,96). **Defeito achado e corrigido antes do 1º run** (fb1b84c): a 0.7.0 fez `getDataDirectory()` devolver o cache local em vez de lançar erro quando `data/` não tem Parquet, e `loadSidecars()` usava esse erro como critério para ler os sidecars versionados — num checkout limpo o job `decide` não achava sidecar nenhum e morria com ENOENT em `freshness.json` (run 34071934742, 19 s); teria derrubado também o schedule de terça. Três camadas: a pasta configurada tem precedência sempre que tiver sidecar (o cache só vale sem nenhum); `freshness-check.mjs --out` grava `unknown` com o motivo mesmo quando a checagem não roda; o passo `decide` cria o estado `unknown` se o arquivo faltar (pedido à mão segue, schedule para com veredito). Reproduzido localmente com `--fixtures` numa pasta só com sidecars. Nota para 1998–2007: sem `RACA_COR` (raça vazia — decidir como o cubo e as notas das ferramentas declaram); taxas de 2000 em diante.

20. **Série histórica 1998–2007 em produção — 28 anos (1998–2025) no canal; raça/cor nula antes de 2008** (2026-09-07, 32ª sessão; ordem do usuário dada no fim da 31ª: segunda das três etapas da série; resta o ESTUDO de 1992–1997, que não é build). **Duas mudanças de código antes do 1º run**, porque o lote não era dispatch puro: (a) healthbR 0.4.0.9000 (2a2840c, main): `sih_years()` começava em 2008 mesmo com `source = "r2"` — o espelho tem 1992–2026, o limite era o da pasta FTP `SIHSUS/200801_`; agora 1992–2024 pelo espelho, FTP segue 2008+ com mensagem que aponta o R2; a 0.4.0 tinha entrado no CRAN nesse mesmo dia (tag v0.4.0 + release em 4b5e5fb), então a mudança foi para o main e o rebuild-cubes.yml segue instalando `SidneyBissoli/healthbR` (o `any::healthbR` do CRAN limitaria o SIH a 2008+); (b) builder 2.4.0 (6af2167): `RACA_COR` vira OPCIONAL (`COLUNAS_OBRIGATORIAS`/`COLUNAS_OPCIONAIS`); `ler_particoes()` lê só as presentes e conta como AUSENTE no ano a coluna que nenhuma linha da competência do ano traz — o healthbR impõe ao prefixo o esquema do ano mais novo pedido, então o cubo de 1998 (lê 1998+1999) não vê a coluna e o de 2007 (lê 2007+2008) a vê com NA, e os dois caminhos dão o mesmo cubo; **decisão do usuário (07/09): `race` NULO em todas as linhas** desses cubos (não "ignorado", não valor próprio; nem nas internações faturadas em 2008-01..04 que já trazem a coluna), sidecar com `columns_missing: ["RACA_COR"]` + nota; `build_data()` recusa ano que o healthbR instalado não aceita; o workflow exige `1998 %in% sih_years()` no passo de conferência. Servidor 0.8.0: `get_available_years` devolve `race_available` por ano e `years_without_race`; get_hospitalizations, get_icsap e get_icsap_indicators acrescentam `notes` quando filtro ou agrupamento por raça alcança ano sem a coluna (o grupo sai `null` no JSON, sem rótulo inventado); descrições avisam. Prova local antes do push: 2007/RR e 1998/RR com raça nula e `columns_missing`; 2023/RR IDÊNTICO à fixture (0 linhas de diferença nos 3 cubos, EXCEPT ALL nos dois sentidos) — golden regravado só pelos campos novos e pela versão. **Seis dispatches** `ufs=all`, 2007 sozinho primeiro (prova do caminho) e depois pares, um rodando + um pendente: 2007 (run 34120365747, build 10 min 49 s, release `cubes-20260907-1220`, sidecar 9e912e9), 2006+2005 (34121713950, 22 min 04 s, `-1246`, 88b659e), 2004+2003 (34121743113, 19 min 31 s, `-1306`, 860ac34), 2002+2001 (34123919366, 20 min 44 s, `-1327`, ee4a4d5), 2000+1999 (34125653855, 17 min 40 s, `-1345`, 9e27671), 1998 (34127732960, 10 min 25 s, `-1356`, af0aa1b) — 1 h 41 min de build. Internações por ano: 1998 12.267.804 · 1999 12.427.470 · 2000 12.493.736 · 2001 12.326.426 · 2002 11.987.201 · 2003 12.104.159 · 2004 11.676.502 · 2005 11.487.429 · 2006 11.764.406 · 2007 11.260.764 — 119.795.897 no lote (160.244.343 AIH lidas), **335.089.033 internações nos 28 anos**; raça nula nos 10 (conferido no DuckDB sobre os cubos baixados da release). **Lacunas do próprio FTP do DATASUS** (conferidas na listagem de `SIHSUS/199201_200712/Dados/`, o espelho é fiel): RDAP0710 (Amapá, out/2007) e RDRR9912–RDRR0005 (Roraima, dez/1999 a mai/2000) nunca foram publicados → cubos 2007 (431 partições), 1999 e 2000 (427) saem com `window.complete = false`; a taxa de RR em 2000 fica subestimada (3.199/100 mil contra 6.329 em SP) e é assim que a fonte é. Canal `sih/cubos/`: 28 anos, 112 arquivos, 1.307 MB. Conferência final: smoke stdio sobre `data/` com 28 cubos OK, `npm run freshness` `current` nos 28 (via range), `get_available_years` 1998–2025 com `race_available` falso em 1998–2007 e `population_years` 2000–2025, taxa de 2000 OK, taxa de 1998 recusada com a mensagem do intervalo, `group_by: ["race"]` em 2005 devolve o grupo null com a nota. Próximo: estudo 1992–1997 (codificação numérica de 6 dígitos em `DIAG_PRINC`; 1992 sem `MUNIC_RES`) — pesquisa, não build.
21. **Estudo 1992–1997 (era CID-9) CONCLUÍDO — pesquisa, não build; decisões do usuário pendentes** (2026-09-07, 33ª sessão; ordem do usuário dada no fim da 32ª: terceira etapa de "a maior série histórica do SIH"). Documento: `docs/analise-002-sih-1992-1997.md`; evidência em `scripts/estudo-1992-1997*.{mjs,py}` (DuckDB httpfs sobre as 1.932 partições de 1992–1997 do R2, 84.627.338 AIH, e as tabelas `TAB_SIH_199201-199712.zip` do DATASUS). **Fatos:** `DIAG_PRINC` é CID-9 da OMS em 6 dígitos — prefixo (0 categorias, 1 causas externas E, 2 suplementar V) + categoria + subcategoria + dígito verificador (módulo 11, pesos 6,5,4,3,2; provado em 8.238/8.240 códigos das `CID9_*.CNV`); 100 % das AIH têm 6 dígitos, 0 vazios, 3 com DV errado, 0 fora das tabelas do DATASUS — decodificar é tabela versionada (o DATASUS tem duas exceções ao DV, `080120`/`080781`, e os dados as seguem). `DT_INTER` (`YYMMDD`) 100 % vazio nas competências 1992-01..04 e 1993-01 (5,08 M + 1,26 M AIH, 27 UFs) e 0 % no resto; `MUNIC_RES` inexistente em 1992–93, 100 % vazio em 1994-01..11, 7–10 % vazio em 1995–97 (TabNet: residência coletada só de 1995); sem `RACA_COR`; `COD_IDADE = 0` e `SEXO = 0` em 4–5 %; `VAL_TOT` na moeda da época (Cr$ → CR$ jul/1993 → R$ jul/1994); janela de 4 meses vale igual (99,74–99,85 % em +4); **fronteira 1997/1998 mista**: 685.870 internações de 1997 faturadas em 1998-01..04 já vêm em CID-10 e `YYYYMMDD` (o cubo de 1997 precisa de `cid_revision` por linha). ICSAP: nenhuma lista oficial em CID-9 (Alfradique 2009 converteu CID-9→CID-10 sem publicar a tabela; AHRQ PQI v6.0/2016 e Caminal 2004 são ICD-9-CM; CMS GEMs 2018 domínio público, aproximadas; OMS só tem tabela do capítulo V). Mapa de capítulos CID-9 → CID-10 por faixa de categoria com 3 exceções (135, 279, 446; 0,15 % das AIH) reproduz os 10 grupos do IDB do DATASUS sem exceção. **Recomendação:** construir 1992–1997 (builder 2.5.0 "era antiga", item próprio, ~2 h de runner) com `cid_chapter` pelo mapa, `cid_group` = categoria CID-9 + coluna `cid_revision`, raça NULL, ICSAP NULL, `uf` = UF do arquivo na era, `value` nominal com `currency` no sidecar, AIH sem data atribuídas à competência com `records_date_imputed`. Seis decisões do usuário, uma por mensagem (§5 do documento). **Defeito colateral achado e NÃO corrigido (ordem: só estudo):** `build-aggregations.R` inverte `COD_IDADE` (trata 2 como meses e 3 como dias; a fonte e o dicionário do healthbR dizem 2 = dias, 3 = meses) — recém-nascidos de 12–30 dias saem com `age` 1 ou 2 em todos os 28 cubos (SP 2023: 6.231 AIH, 0,23 %; 8 % dos neonatos em dias); correção = 1 linha + teste de contrato + rebuild dos 28 anos (~6 h de runner); registrado no TAREFAS.md do monitor como `sih:cod-idade`. **Decisões do usuário (07/09, fim da 33ª, uma por mensagem):** (i) construir os seis anos 1992–1997; (ii) AIH sem `DT_INTER` (1992-01..04 e 1993-01) atribuídas à competência, `records_date_imputed` no sidecar e nota nas ferramentas; (iii) ICSAP com **lista CID-9 derivada, "a mais robusta possível", ANTES do build** — por grupo da Portaria 221, códigos das listas de origem em CID-9 (Caminal 2004, Billings 1993, AHRQ PQI v6.0, CIHI), GEMs só no resíduo e marcadas, validação pelos pares do DATASUS e validação empírica na fronteira 1997/98 (internações de 1997 em CID-9 vs em CID-10, razão de comparabilidade por grupo e UF), tabela versionada com fonte/método/licença/razões, `icsap_list_revision = "cid9-derivada"`, nota nas ferramentas; (iv) `uf` = UF do arquivo nos seis anos, município nulo, **muito bem documentado** (sidecar `uf_basis`, descrições, `get_available_years`, docs do canal); (v) `value` nominal na moeda da época com `currency` por período e nota; taxas 1992–1999 via `pop_uf_agregado` viraram item próprio no monitor (`sih:taxas-1992-1999`); (vi) cubo de 1997 com a janela normal e `cid_revision` por linha (ausente = 10 nos cubos 1998+). Ordem: lista ICSAP CID-9 (item próprio) → builder 2.5.0 + correção `sih:cod-idade` numa campanha só → taxas.
22. **Lista ICSAP em CID-9 derivada e validada — `src/data/csap-groups-cid9.json`; builder não mudou** (2026-09-07, 34ª sessão; ordem do usuário dada no fim da 33ª: executar a decisão (iii) do estudo 1992–1997 "de forma eficiente e correta"). Documento: `docs/analise-003-icsap-cid9.md`; scripts `estudo-icsap-cid9-derivar.py` (a correspondência em código, reprodutível das tabelas `CID9_*.CNV` do DATASUS; falha se rubrica inexistente ou em dois grupos), `estudo-icsap-cid9-fronteira.mjs` (recortes A/B/C no healthbr-data) e `estudo-icsap-cid9-analise.py` (razões, classes, `validation.json`). **Lista:** 19 grupos, 156 rubricas CID-9 (OMS), 439 códigos de 6 dígitos, cada rubrica com `source[]`, `method` (exact/category/approximate), rótulo do DATASUS, AIH de 1997 e nota; `not_official: true`, `icsap_list_revision: "cid9-derivada"`. Correspondência MANUAL por rubrica homônima (todas), com Caminal 2004 (núcleo/ampliada/revisados — 72 rubricas), AHRQ PQI v6.0 ICD-9-CM 2016 (31), CIHI 2008 coluna ICD-9 (22), par `DIAGPACTO9` do DATASUS (250.1–250.2) e GEMs só em 514 e na conferência cruzada; perímetro da Portaria manda (485/486, 482.4, 483, 558, 590.2, 430/431, 410 ficam fora mesmo constando nas listas de origem — `metadata.excluded` com o peso de 1997). Cobre 26,16 % das AIH de 1997. **Validação empírica** (participação por grupo: 1997 em CID-9 vs 1998-03..12 em CID-10, classes a priori alta 0,80–1,25 / média 0,67–1,50 / baixa): razão global **1,05**; 16 grupos alta, g06 média (0,76), **g03 (0,21) e g05 (4,75) baixa por mudança de prática de codificação** (281.9 → D50.9/D64.9; 465.9 IVAS 73 mil → J06 15 mil), não da lista — ficam marcados `comparability`. A validação decidiu: 411 FORA da angina (↔ I24; razão 1,14 sem, 1,44 com) e 8 rubricas asterisco específicas dentro (320.4, 484.0, 484.3, 730.4–6, 362.0, 357.2; 614 AIH). Jan–fev/1998 têm ICSAP total em 19–20 % (adaptação à CID-10) e voltam a 24,5 % em março — as internações de 1997 faturadas nesses meses terão ICSAP subestimado (efeito da fonte). **Armadilhas registradas:** ICD-9-CM renumera 250.x (CM 250.4 renal = OMS 250.3), 320.4 é meningite tuberculosa na OMS, 411 sem subdivisão na OMS, 481 inclui a lobar NE (J18.1), AHRQ/CIHI excluem 401.1 e a Portaria não. Recortes A (mesmas internações de dez/1997 nos dois códigos) e B (competências vizinhas) rodados pelo usuário em seguida: confirmam g03 e g05 como únicos desvios e mostram que a queda de jan–fev/1998 foi desigual por UF (BA 28 → 9,5 %, SC, GO, MA, RJ, PB > 1,8; PE, SE, TO, ES, AL, PA, AM ≈ 1) — o ICSAP das internações de 1997 faturadas em 1998-01..04 será subestimado nessas UFs (analise-003 §3.4). **Para o builder 2.5.0:** classificar por tabela (`codes6` → grupo) quando `cid_revision = 9`, sidecar com `icsap_list_revision` e `icsap_comparability`, nota nas ferramentas para ano < 1998; unificar a lista CID-10 em tabela também.

---

## REGRAS PARA DADOS POPULACIONAIS

### Hierarquia de fontes
1. **Primeiro:** Usar dados que o IBGE disponibiliza
2. **Segundo:** Se IBGE não tiver, usar dados que o DATASUS disponibiliza
3. **Nunca:** Criar dados que nem IBGE nem DATASUS disponibilizam

### Proibições absolutas
- ❌ **PROIBIDO interpolar** dados entre anos
- ❌ **PROIBIDO incluir projeções futuras**: o último ano de população é o
  último ano de CUBO FECHADO do SIH (janela de competências completa), nunca
  além. Regra reescrita em 2026-09-06 com o sim do usuário (antes dizia
  "após 2024"): com o cubo de 2025 fechado, a população vai até 2025; 2026
  só quando o cubo de 2026 fechar (competência 2027-04 publicada).
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

Projeções por UF do IBGE (SIDRA tabela 7358, revisão 2018), com sexo e idade simples. Vai até o último ano de cubo FECHADO do SIH (regra acima); o servidor lê o intervalo do arquivo (`getPopulationYearRange()`), nunca o fixa.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| year | int | Ano (2000 até o último cubo fechado; 2025 desde 2026-09-06) |
| uf | string | Sigla UF |
| sex | string | "M" ou "F" |
| age | int | Idade simples (0-90, onde 90 = 90+) |
| population | int | População |

**Estatísticas:** 122.364 registros, 27 UFs, 2000-2025 (4.914 linhas por ano)

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
