# CLAUDE.md

Orientação para o Claude Code neste repositório. O **diário de decisões** é o
`CONTEXT.md` (decisões numeradas 1–51, com o porquê e a medição de cada uma);
`docs/` guarda o ADR, os planos e as análises. Este arquivo resume o que é
preciso saber para mexer no código sem repetir erro já pago — e aponta para lá
em vez de duplicar. Ao fechar uma decisão nova, ela vai para o `CONTEXT.md`
com o número seguinte.

## O que é

Servidor MCP publicado no npm como `sih-br-mcp` (bin `dist/index.js`), com
**12 ferramentas** sobre as internações do SIH/SUS (AIH, 1992–2025):
contagens por causa (capítulo/grupo CID-10, CID-9 antes de 1998), séries,
taxas por população (`rate` na base de `rate_per`, padrão 100 mil;
`rate_per_100k` deprecado, decisão 45) e ICSAP pela lista brasileira
(Portaria 221/2008; lista CID-9 derivada para 1992–1997, decisão 22).

Ferramentas: `get_hospitalizations`, `get_hospitalization_trends`,
`get_hospitalization_rates`, `compare_regions`, `get_icsap`,
`get_icsap_indicators`, `compare_icsap_trends`, `rank_csap_groups`,
`classify_as_csap`, `list_csap_groups`, `list_cid_chapters`,
`get_available_years`.

**O servidor não lê microdado nem o FTP.** Lê CUBOS pré-agregados em Parquet,
produzidos pela pipeline `sih-cubos` do **healthbr-data**
(`scripts/pipeline/sih-cubos/`, workflows `rebuild-sih-cubes.yml` e
`build-sih-population.yml`; decisões 10, 27, 28) e publicados em
`https://data.sidneybissoli.com/sih/cubos/` com `manifest.json` (tamanho e
SHA-256 por arquivo). Este repositório é **consumidor puro** desde a 0.11.0:
não há R aqui.

Dois canais em produção:

- **npm / stdio** — `npx -y sih-br-mcp`.
- **Remoto** — `https://sih.sidneybissoli.com/mcp`: Worker de borda na
  Cloudflare que encaminha ao **Cloudflare Container** que roda `dist/http.js`
  (DuckDB nativo não roda em isolate; decisão 29, PLAN-004).

Ramo padrão: **`master`**.

## Comandos

```bash
npm run build                 # tsc → dist/ (não há script typecheck na raiz: `npx tsc --noEmit`)
npm test                      # vitest (tests/)
npm run smoke:stdio           # superfície pelo stdio contra baselines/surface-stdio.json (fixture)
npm run smoke:http            # a mesma régua pelo transporte HTTP
npm run golden:tools          # valores das 12 ferramentas byte a byte contra baselines/golden-tools.json
npm run equiv:summary | equiv:series | equiv:causas   # pré-agregado = cubo cheio (decisões 31 e 34)
npm run cube:isolation        # o cubo só lê cubo (decisão 35)
npm run freshness:selftest    # frescor contra a fixture
npm run tables:check:offline  # src/data/ × excerto do manifesto do canal (SHA-256)
npm run cache:selftest
npm run surface:lock          # regrava surface.lock.json + o bloco do registro no server.json
npm run manifest:lhm          # regera lhm.plugin.json

cd worker && npm test         # borda: auth, rate limit, proxy, status, card, trava sem token
cd worker && npm run typecheck
cd worker && npx wrangler deploy   # deploy à mão (normalmente é o CI, na tag)
```

Os `*:baseline` (`smoke:stdio:baseline`, `golden:tools:baseline`) REGRAVAM a
referência — só com diferença deliberada e explicada.

## Arquitetura

**Um despacho, dois transportes.** `src/tools.ts` tem as 12 ferramentas e o
`callTool()`, único despacho; `src/server.ts` é a factory `createServer()`
(McpServer do SDK v2, títulos, anotações, `instructions`; decisões 29 e 43).
`src/index.ts` é a entrada stdio (`serveStdio`, dual-era, com o guarda de
cursor de `src/pagination.ts` instalado no `onmessage` do transporte);
`src/http.ts` é a entrada Streamable HTTP do container (`createMcpHandler`
dual-era, SSE com keepalive porque a série de 34 anos leva ~30 s; `/healthz`
não abre o DuckDB). O container não valida Host/Origin: isso, o bearer
opcional, o rate limit e o Analytics Engine moram no Worker
(`worker/src/index.ts`, `mcp-proxy.ts`, `auth.ts`, `rate-limit.ts`), o único
que fala com ele. `worker/src/container.ts` é o Durable Object `SihContainer`
(`@cloudflare/containers`); `worker/wrangler.jsonc`: `instance_type: basic`,
`max_instances: 1`, imagem `../Dockerfile`.

**Dados.** `src/db/duckdb.ts` é o ÚNICO lugar que toca o cliente
`@duckdb/node-api` (funil `query()`, decisão 7), com desempate de ordem por
toda coluna de agrupamento (decisão 8). `src/cache.ts` baixa do canal só os
anos e os TIPOS de cubo que a chamada pede (`causas`, `series`, `icsap`;
decisão 32), conferindo SHA-256, para `~/.cache/sih-br-mcp/cubos/` — o pacote
npm não embarca cubo (~60 MB por ano). Pré-agregados (resumo e estratos de
causas e ICSAP; PLAN-005/006, decisões 31 e 34) atendem as consultas grandes.
`src/freshness.ts` confere o frescor frente ao espelho na inicialização, sem
bloquear (decisão 13). `src/data/` traz CÓPIAS das tabelas de classificação do
produtor (conferidas por `tables:check`) e `brazil-regions`/`cid-chapters`.
População (`pop_uf`, `pop_uf_agregado`, `pop_municipios`) vem do mesmo canal
(decisão 28), via `src/utils/population.ts`.

**Rede: um ponto só.** `src/upstream.ts` é o fetch comum do portfólio
(`@sbissoli/mcp-upstream`): política medida, e o coletor do `retrieval` da
proveniência (decisão 44).

**Proveniência em toda resposta** (`src/provenance.ts`,
`@sbissoli/mcp-provenance`, decisão 12): a fonte é o Ministério da
Saúde/DATASUS; o healthbr-data aparece como redistribuição, nunca como fonte.
`retrieved_at` = o download **mais antigo** do `.dbc` entre as partições
usadas (decisão 51, 1.3.0; até a 1.2.3 era o mais recente) — é o registro de
safra, não o instante da chamada, e por isso o golden pode gravar o bloco.

**Erros com classe.** `src/erros.ts`: `ErroInterno` (defeito), `ErroDeContrato`
(quem chamou errou), `FalhaDaFonte` (o canal falhou). Toda exceção lançada de
`src/` declara a classe (decisão 48), que viaja à borda em `_meta` e vira a
classe na telemetria (decisão 47). O "erro-mole" (`{ error, data: [] }` num
sucesso) fica só para o que é deliberado; exceção é erro de verdade
(decisão 49).

**Contrato de saída.** `outputSchema` nas 12 ferramentas, escrito à mão em
`src/output-schemas.ts` e servido verbatim (decisão 39), conferido pelo
`Client` do SDK, que reprova contra o schema LISTADO (decisão 50).

## Testes

- `tests/` (vitest): rota (`routing`), contrato de saída com forma de cliente
  (`output-contract`), ausência de ano (`ano-ausente`, `ano-ausente-frio`,
  decisões 38 e 41), CID não classificável (decisão 40), classe do erro e a
  guarda dela (decisões 47–49), base da taxa (`taxa-base`, decisão 45),
  `retrieved-at-mais-antigo` (decisão 51), paginação e `server/discover`
  (decisão 43), `instructions`, `upstream`, `fixture-congelada` (decisão 46),
  `lhm-manifest`, `surface-lock`.
- `worker/tests/`: auth, rate limit, proxy, sessão, status, card,
  `tools-sync`, telemetria (`call-shape`, `analytics`, `usage-core`),
  `surface-lock` (quem responde sem token, medido na borda).
- **A fixture é `tests/fixtures/sih`**, versionada e CONGELADA pelo marcador
  `.fixture-somente-leitura`: com ele na pasta de `SIH_DATA_DIR`, o cache fica
  desligado venha quem vier (decisão 46). `data/*.parquet` é gitignored.
- O gate de CI nasceu como smoke + golden pelo stdio sobre a fixture
  (decisão 9); a suíte vitest veio depois (decisão 37). Os dois valem.

## Trava da superfície (`surface.lock.json`)

Mudou a superfície sem subir a versão = teste vermelho. Duas seções:
`declarada` (`initialize` + tools + resources + templates + prompts,
capturada em memória por `tests/surface-lock.test.ts`) e `semToken` (quem
responde sem credencial, medido na borda por `worker/tests/surface-lock.test.ts`).
Fluxo: subir a versão (ver Release) → `npm run surface:lock` → commitar a
trava. O sih não serve resources nem prompts (`null` na trava).

**Desde a 1.4.2 a impressão digital vai no `server.json`** (`_meta` →
`io.modelcontextprotocol.registry/publisher-provided` →
`io.github.sidneybissoli/mcp-surface`, forma `mcp-surface/1`, SPEC.md do
`@sbissoli/mcp-surface`): o MCP Registry a publica com a versão para o
CLIENTE conferir. O `surface:lock` termina com
`mcp-surface registro --tool list_cid_chapters`; o teste da trava reprova
`server.json` defasado — e é **pulado em modo de escrita**
(`it.skipIf(modoEscrita())`), porque o `travar` roda o arquivo antes de o
`registro` gravar o bloco. No fim do `deploy-container.yml`,
`npx mcp-surface verificar https://sih.sidneybissoli.com/mcp --tool list_cid_chapters`
prova que o ar é o travado; no fim do `publish.yml`,
`mcp-surface conferir-registro` compara a entrada do registro com o ar, como
um cliente, sem ler a trava.

## CI

- `ci.yml` (push em `master`, PR): build, worker (typecheck + testes), `npm test`,
  smoke stdio e http, golden, as três equivalências, isolamento do cubo,
  selftests de frescor e cache, `tables:check` (offline e contra o canal).
- `deploy-container.yml` (**tag `v*`** + dispatch): `wrangler deploy` do Worker
  e do container, confere que a versão hospedada bate com o `package.json` e
  roda o `mcp-surface verificar`. Na TAG e não no push, de propósito: o deploy
  reconstrói a imagem e troca a instância, e já houve sonda travando 900 s
  depois de um deploy (`docs/plan-006-causas-pre-agregada.md`). Roda em
  PARALELO ao `publish.yml`: o container compila do fonte, não do npm, e
  `workflow_run` faria checkout do branch padrão em vez da tag.
- `publish.yml` (**tag `v*`** + dispatch): testes → npm (trusted publishing,
  OIDC) → espera o npm expor a versão → `mcp-publisher` (OIDC) →
  `conferir-registro`. Confere `package.json` = `server.json` (raiz e
  `packages[0]`) e o `mcpName`.
- `mcpscore.yml`: catraca de conformidade — stdio no PR, produção depois do
  deploy, e semanal (decisão 43).

## Release

Este repositório **não tem hook de versão** (os irmãos têm
`scripts/sync-version.mjs`). À mão, no mesmo commit:

1. `package.json` → nova versão (o `npm view sih-br-mcp version` é a versão
   publicada de verdade; numerar a partir dela).
2. `server.json` → `version` **e** `packages[0].version` (o `publish.yml`
   reprova se divergirem).
3. `lhm.plugin.json` (`npm run manifest:lhm`).
4. `npm run golden:tools:baseline` — a citação da proveniência leva a versão,
   então o golden muda a cada release (só nessas linhas).
5. Se a superfície mudou: `npm run surface:lock`.
6. Entrada nova no `CHANGELOG.md`, cobrindo tudo desde a última versão PUBLICADA.
7. PR → merge em `master` → **`gh release create v<versão> --target master
   --generate-notes`**. Ele cria a tag pela API, e o push da tag dispara
   `publish.yml` e `deploy-container.yml` (os dois em `push: tags: ["v*"]`).
   **Não empurrar a tag sozinha:** nenhum dos dois workflows cria a release do
   GitHub, e a versão fica sem página (aconteceu com a 1.4.2, em 07/10/2026; o
   conserto sem republicar é `gh release create v<x> --verify-tag`).

O histórico está no `CHANGELOG.md`, reconstruído em 08/10/2026 a partir de tags,
releases, datas do npm e commits; o porquê das decisões, no `CONTEXT.md`.

## Pontos que mordem

- **O `npm install` no Windows apaga os campos `libc` do `package-lock.json`**
  (o CI em Linux precisa deles). Use `npm ci`; ao subir dependência, devolva com
  `node C:\dev\skills\scripts\restore-libc.mjs <lock-do-HEAD> package-lock.json`.
  Vale para o lock de `worker/` também.
- **Probe avulso contamina a fixture.** Rodar o servidor com
  `SIH_DATA_DIR=tests/fixtures/sih` e o cache ligado baixava o grão A real
  para dentro da fixture; daí o marcador `.fixture-somente-leitura`
  (decisão 46). Smoke e golden também rodam com `SIH_CUBES_CACHE=off` e
  `SIH_FRESHNESS_CHECK=off` para não depender de rede.
- **O glob do cubo pegava os pré-agregados.** `sih_<tipo>_*.parquet` casava
  com `sih_causas_resumo.parquet` e os estratos, que somavam junto em
  silêncio (achado por usuário real, decisão 35). `cube:isolation` guarda isso.
- **Ano que não existe não é zero.** Antes, `year: [2030]` devolvia medidas
  nulas e total 0, que se lê como "não houve internação". A ausência tem UMA
  resposta, no funil, com `published_years` (decisões 38 e 41).
- **Cache que baixava os três cubos do ano** (~1,6 GB) para consulta que lê um
  tipo — "total do Brasil desde 1992" levava 4 min (decisão 32).
- **Notas de era que sumiam.** As ressalvas que tornam 1992–1997 interpretável
  saem do sidecar, e um array vazio memoizado (truthy em JS) as apagava
  (decisão 33).
- **Container de 1 GiB não cabia a série ICSAP** de uma vez: a consulta é ano
  a ano (decisão 30). Cold start medido em ~16,6 s com o container dormindo.
- **CID-9 (1992–1997):** a lista ICSAP é DERIVADA, não oficial, com grupos não
  comparáveis; `uf` é a do ARQUIVO; `value` é nominal pré-real
  (`docs/analise-002-sih-1992-1997.md`, `docs/analise-003-icsap-cid9.md`,
  decisões 21–24). Raça/cor é nula antes de 2008 (decisão 20).
- **População** (`CONTEXT.md`, "Regras para dados populacionais"): só o que
  IBGE ou DATASUS publicam; proibido interpolar e proibido projetar além do
  último cubo FECHADO do SIH; agregar municípios em UF é permitido.
- **`classify_as_csap` só responde CID-10**, aceitando as duas notações do
  mesmo código (com e sem ponto) — decisão 40.
- **Para fechar defeito de produção, prove em produção**: a sonda da borda e o
  `mcp-surface verificar` olham o container, não o código; e o container só
  muda na TAG.
