# sih-br-mcp

Servidor MCP (Model Context Protocol) para análise das internações hospitalares do
SUS (SIH/SUS, AIH reduzida) com foco em ICSAP — internações por condições sensíveis
à atenção primária. Doze ferramentas sobre cubos anuais de 1992 a 2025 (causas por
capítulo/grupo CID, séries mensais, ICSAP por município, taxas por 100 mil), com a
proveniência da safra em cada resposta.

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
