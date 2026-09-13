# DATASUS SIH/SUS — MCP Server de internações hospitalares (AIH) do Brasil, 1992–2025

Servidor MCP (Model Context Protocol) que responde perguntas sobre as **internações
hospitalares do SUS** — o SIH/SUS do DATASUS, AIH reduzida — dentro do assistente de
IA, sem TabNet, sem baixar `.dbc` do FTP e sem escrever SQL. Doze ferramentas sobre
**34 anos** (1992 a 2025, 420.103.883 internações): causas por capítulo e grupo da
CID-10 (CID-9 antes de 1998), séries mensais, **ICSAP** — internações por condições
sensíveis à atenção primária, lista brasileira — e **taxas** brutas, específicas ou
padronizadas por idade, por UF e por município. Cada estrato traz internações, dias de
permanência, **valor pago pelo SUS** e óbitos, com a proveniência da safra e a citação
da fonte em cada resposta.

> **In English.** MCP server for **Brazilian hospital admissions** (DATASUS SIH/SUS,
> "AIH" records), 1992–2025: causes by ICD-10 chapter and group (ICD-9 before 1998),
> monthly series, **ambulatory care sensitive conditions** (ICSAP/ACSC, Brazilian
> list) and crude, age-specific or age-standardized **rates** by state and
> municipality — answered inside Claude, ChatGPT or any MCP client, with provenance
> and a citation in every answer. No FTP download, no DBC decoding, no SQL:
> `npx -y sih-br-mcp`.

## Perguntas que ele responde

Em linguagem comum, no cliente MCP: quem escolhe a ferramenta e os parâmetros é o
assistente.

- "Quantas internações por pneumonia houve no Espírito Santo em 2024, por faixa de
  idade?" (`get_hospitalizations`)
- "A taxa de ICSAP de Roraima caiu entre 2010 e 2023?" (`get_icsap_indicators`)
- "Compare a internação por 100 mil habitantes entre Norte e Sudeste em 2023,
  padronizada por idade." (`get_hospitalization_rates`, `compare_regions`)
- "Quais condições sensíveis à atenção primária mais internam no meu município?"
  (`rank_csap_groups`)
- "Série mensal de internações por dengue desde 1998." (`get_hospitalization_trends`)
- "J18.9 é condição sensível à atenção primária?" (`classify_as_csap`)

## Comparação com as alternativas

Quem trabalha com SIH/SUS em R ou Python já tem ferramentas consolidadas, e este
servidor **não substitui nenhuma delas** — ele ocupa um lugar diferente da cadeia:
responde a pergunta agregada no ponto onde ela é feita, dentro do assistente, sem
ETL e sem download de microdado. Detalhe, exemplos lado a lado e os números medidos
em [`docs/comparativo-alternativas.md`](docs/comparativo-alternativas.md).

| Ferramenta | O que faz | Quando preferir |
| --- | --- | --- |
| **sih-br-mcp** (este) | Responde agregados de 34 anos direto no assistente de IA, com ICSAP, taxas padronizadas e proveniência por resposta | A pergunta é agregada (UF, município, ano, mês, CID, idade, sexo, raça, ICSAP) e a resposta tem de ser auditável |
| [microdatasus](https://github.com/rfsaldanha/microdatasus) 3.0.0 (R, CRAN) | Baixa e processa microdados do DATASUS (SIH, SIM, SINASC, SIA, CNES, SINAN): trata o DBC e rotula as variáveis | Você precisa do **registro individual** da AIH, de variáveis fora dos cubos ou de outro sistema do DATASUS |
| [PySUS](https://github.com/AlertaDengue/PySUS) 2.11.2 (Python) | Ferramentas para os dados públicos de saúde brasileiros; lê DBC/DBF do FTP do DATASUS | Seu pipeline é Python e você quer ETL próprio sobre o microdado |
| [read.dbc](https://cran.r-project.org/package=read.dbc) 1.2.0 (R, CRAN) | Lê e descomprime o formato `.dbc` do Ministério da Saúde | Você já tem os arquivos e só precisa abri-los |
| [csapAIH](https://fulvionedel.github.io/csapAIH/) (R, GitHub) | Classifica AIH em ICSAP pela lista brasileira (é a referência que este servidor confere) | A classificação é sobre o **seu** microdado, em R |
| [brpop](https://cran.r-project.org/package=brpop) 0.7.0 (R, CRAN) | Estimativas populacionais brasileiras por município, UF, sexo e faixa | Você calcula as próprias taxas e quer o denominador em R |
| [healthbR](https://cran.r-project.org/package=healthbR) 0.4.0 (R, CRAN) | Irmão em R deste servidor: acessa dados públicos de saúde do Brasil pelo mesmo espelho Parquet | Você está em R e quer o dado numa `data.frame` para seguir analisando |

**Não use este servidor quando** a pergunta exigir o registro individual da AIH,
variáveis que os cubos não carregam (procedimento realizado, CNES do estabelecimento,
caráter de atendimento, diagnóstico secundário) ou outro sistema do DATASUS (SIM,
SINASC, SIA, SINAN) — nesses casos o caminho é microdatasus, PySUS ou o espelho
Parquet do [healthbr-data](https://github.com/SidneyBissoli/healthbr-data). O que os
cubos carregam por estrato está em
[`docs/tool-specifications.md`](docs/tool-specifications.md): internações, dias de
permanência, valor pago (R$) e óbitos, por ano, mês, UF, município, capítulo e grupo
CID, sexo, idade, raça/cor e grupo ICSAP.

## De onde vêm os dados

Este servidor é **consumidor** do canal público `sih/cubos/` do projeto
[healthbr-data](https://github.com/SidneyBissoli/healthbr-data):

```
Ministério da Saúde / DATASUS (RD<UF><AAMM>.dbc, FTP)
  → healthbr-data sih/rd/ (Parquet 1:1, manifesto com MD5 e data de download)
  → healthbr-data pipeline sih-cubos (scripts/pipeline/sih-cubos/build-aggregations.R)
  → https://data.sidneybissoli.com/sih/cubos/  (cubos + sidecar por ano + manifest.json + tables/)
  → este servidor (cache local sob demanda, SHA-256 conferido contra o manifesto)
```

Até 08/09/2026 o builder dos cubos vivia aqui (`scripts/build-aggregations.R`,
`rebuild-cubes.yml`); desde então o produtor é o healthbr-data e este repositório
não gera nem publica cubo nenhum (CONTEXT.md, decisão 27). A receita completa está
em `healthbr-data/scripts/pipeline/sih-cubos/README.md` e no card
[`sih-cubos`](https://github.com/SidneyBissoli/healthbr-data/blob/master/guides/dataset-cards/sih-cubos-README.md).

- **Cubos:** baixados por ano, só os que a chamada pede, para
  `~/.cache/sih-br-mcp/cubos/` (`SIH_CACHE_DIR`), com o sidecar
  `sih_provenance_<ano>.json` ao lado. `SIH_CUBES_BASE_URL` aponta outro canal;
  `SIH_CUBES_CACHE=off` desliga (smoke e golden usam).
- **Frescor:** `src/freshness.ts` compara o sidecar com `sih/rd/manifest-summary.json`
  e avisa quando um cubo está atrás do espelho; quem reconstrói é o produtor
  (`rebuild-sih-cubes.yml`, toda terça e após cada manutenção do espelho).
- **Pré-agregados** (blocos `icsap_summary`, desde a 0.14.0, e `causas_summary`,
  desde a 0.15.0): atalhos DERIVADOS dos cubos publicados, no mesmo canal. O da
  ICSAP é um resumo de 276 KB mais os estratos por ano; o de causas é o **grão A**
  (`sih_causas_resumo.parquet`, 569 KB com os 34 anos: `year × uf × cid_chapter ×
  cid_revision × is_csap × exclusion` com internações, dias, valor e óbitos) mais o
  **grão B** por ano, que acrescenta sexo, faixa etária quinquenal e raça. Uma
  chamada que cabe no grão responde sem baixar cubo nenhum — "internações e gasto
  por ano desde 1992" custa 569 KB em vez de 1,25 GB. O roteamento é conservador:
  o que não cabe (mês, categoria CID de 3 dígitos, grupo CSAP, idade fora das
  faixas quinquenais) cai no cubo e sai exato. Cada ano só usa o pré-agregado se o
  `derived_from` do manifesto ainda bater com o SHA-256 do cubo publicado; rebuild
  sem nova derivação devolve aquele ano ao caminho lento, nunca ao número errado.
- **Tabelas de classificação** (`src/data/`): cópias do contrato publicado em
  `sih/cubos/tables/`; `npm run tables:check` confere o SHA-256 contra o manifesto
  (roda no CI). Nunca edite aqui — a fonte é o produtor.
- **População** (`pop_uf.parquet`, `pop_uf_agregado.parquet`, `pop_municipios.parquet`):
  desde a 0.12.0 vem do mesmo canal, assinada no bloco `population` do `manifest.json`
  (produtor: `build-population.R` + `build-sih-population.yml` do healthbr-data — IBGE,
  Projeção 2024 por UF; DATASUS POPBR/POPSVS por município). As ferramentas de taxa
  (`get_hospitalization_rates`, `compare_icsap_trends` com `rate_per_10k`) e
  `get_available_years` baixam os três arquivos para o cache na primeira chamada,
  com SHA-256 conferido; uma pasta de dados que já tenha `pop_uf.parquet` tem
  precedência (fixture, build local). A proveniência da população responde com o
  `built_at` do manifesto.

## Uso

Pacote no npm: [`sih-br-mcp`](https://www.npmjs.com/package/sih-br-mcp) (Node 22+).
Ele não embarca dado nenhum — cubos, tabelas e população vêm do canal na primeira
chamada e ficam no cache local.

```bash
npx -y sih-br-mcp           # stdio
```

Configuração num cliente MCP (Claude Desktop, Claude Code):

```json
{ "mcpServers": { "sih": { "command": "npx", "args": ["-y", "sih-br-mcp"] } } }
```

A partir do código-fonte:

```bash
npm install
npm run build
node dist/index.js          # stdio
```

Variáveis: `SIH_DATA_DIR` (pasta com cubos já prontos, em vez do cache),
`SIH_CACHE_DIR`, `SIH_CUBES_BASE_URL`, `SIH_CUBES_CACHE=off`,
`SIH_FRESHNESS_CHECK=off`.

### Servidor remoto (Streamable HTTP)

As mesmas 12 ferramentas por HTTP, para conectores remotos (claude.ai):

```bash
npm run start:http          # http://localhost:8080/mcp  (GET /healthz para sondar)
```

`PORT` e `SIH_HTTP_HOST` além das variáveis acima. Sem sessão: cada request
cria servidor e transporte novos, então qualquer instância atende qualquer
chamada. Em produção roda num Cloudflare Container (`Dockerfile`, população
pré-baixada na imagem) atrás do Worker de borda em `worker/`, que cuida de
domínio, rate limit, autenticação opcional e medição — desenho e custos em
`docs/plan-004-servidor-remoto.md`.

## Verificação

```bash
npm ci && npm run build
npm run smoke:stdio         # superfície das ferramentas × baselines/surface-stdio.json
npm run smoke:http          # mesma superfície e chamadas pelo transporte HTTP (dist/http.js)
npm run golden:tools        # 12 ferramentas byte a byte × baselines/golden-tools.json (fixture 2023/RR)
npm run freshness:selftest  # frescor offline sobre um trecho versionado do manifesto
npm run cache:selftest      # cache local (download + SHA-256) contra um canal falso
npm run tables:check        # tabelas de src/data × manifesto do canal
npm run equiv:summary       # pré-agregados da ICSAP × caminho clássico, byte a byte
npm run equiv:series        # roteamento para o cubo leve de séries
npm run equiv:causas        # pré-agregados de causas (grão A e B) × cubo, byte a byte
```

O CI (`.github/workflows/ci.yml`) roda tudo isso em Node 22 e 24. A fixture
`tests/fixtures/sih/` é uma cópia real dos cubos de 2023/RR gerados pelo builder
(hoje no healthbr-data) — é o que torna medível qualquer bump.

## Documentação

- `CONTEXT.md` — decisões arquiteturais numeradas (a 27 é a migração do produtor; a 29, o servidor remoto).
- `docs/analise-001` (janela de competências), `analise-002` (era CID-9, 1992–1997),
  `analise-003` (lista ICSAP em CID-9 derivada), `plan-002` (DuckDB Node Neo),
  `plan-003` (rebuild automático, hoje no healthbr-data), `plan-004` (servidor remoto
  HTTPS para o claude.ai), `plan-005` (série pré-agregada da ICSAP), `plan-006`
  (cubo de causas pré-agregado), `tool-specifications.md`.

## Licença

MIT (`LICENSE`). Os dados são do Ministério da Saúde / DATASUS; a redistribuição em
Parquet e os cubos derivados são do healthbr-data (CC-BY-4.0).
