# PLAN-004 — sih-br-mcp como servidor MCP remoto (HTTPS) para o claude.ai

Item `sih:servidor-remoto` do portfolio-monitor. Pedido do usuário em
08/09/2026: "já posso habilitar o mcp via https no meu claude.ai? qual a
URL?". Não havia URL: o servidor é só stdio (`npx -y sih-br-mcp`), usa DuckDB
nativo e um cache em disco com cubos de 23–72 MB por ano — não roda em
Cloudflare Worker como ibge/senado/bcb. Modelo: PLAN-002 e PLAN-003 (fatos
medidos → desenho → fases com critério de saída → riscos → fora de escopo).

**Decisões já tomadas pelo usuário (08/09/2026, fim da 38ª sessão):** host =
Cloudflare Containers (Fly.io e VPS Hetzner descartados); transporte
Streamable HTTP; SDK v2 (`@modelcontextprotocol/server` 2.0.0, estável desde
27/07/2026, o que o ibge já roda); sem OAuth (o claude.ai aceita conector sem
autenticação) + rate limit por IP no Worker de borda; uma ferramenta por ação,
como está. Nenhum recurso pago é criado sem o usuário dizer.

## 1. Fatos medidos (08/09/2026, dist local do 0.12.1, `data/` com 34 anos)

| O quê | Medida |
|---|---|
| Canal `sih/cubos/` | 34 anos, 1.653 MB de cubos (23,2–71,8 MB/ano), população 13,4 MB, manifesto 1.2.0 |
| `get_hospitalizations` 2023/SP por capítulo | 1.110 ms na 1ª chamada (abre o DuckDB), 48 ms depois |
| `get_hospitalization_rates` 2023/RR | 27 ms |
| `get_icsap_indicators` 2023/SP | 7 ms |
| `get_hospitalizations` 2019–2025 UF×capítulo | 1.368 ms, resposta de 100 kB |
| `compare_icsap_trends` 1992–2025 | **30,6 s** (lê 34 cubos ICSAP); 2000–2025 `rate_per_10k` 16,9 s |
| RSS do processo | 74 MB ao subir; 236 MB após a série de 34 anos; ~320 MB após 4 consultas pesadas |
| Cold start do stdio | ~1 s (DuckDB) + download sob demanda (2023 inteiro ≈ 66 MB em ~5 s) |

**Remedido em 09/09/2026 pelo transporte HTTP local (0.13.0, `data/` com 34
anos, cache do SO quente):** `initialize` 53 ms; `tools/list` 6 ms;
`get_icsap_indicators` 2023/SP 71 ms; `get_hospitalizations` 2019–2025
UF×capítulo 523 ms (112 kB); `compare_icsap_trends` 2000–2025 `rate_per_10k`
1,3 s; 1992–2025 por grupo CSAP 5,2 s; 1992–2025 por TODAS as UFs 7,8 s
(30 kB). Os 30,6 s de 08/09 não se reproduziram — provável leitura fria dos
34 Parquet pelo SO; no container o pior caso inclui o download dos cubos.

Consequências: instância de 1 GiB serve 1–2 usuários simultâneos; a série
inteira precisa de resposta em SSE (conexão viva) e o timeout do cliente do
claude.ai tem de ser MEDIDO na F4, não suposto; `initialize` nunca baixa nada
(o review do Claude exige resposta em < 10 s).

## 2. Requisitos do claude.ai e do review de conectores (lidos em 08/09/2026)

- Servidor público; OAuth OPCIONAL ("Advanced settings"); Free = 1 conector;
  Team/Enterprise só Owners adicionam. Transporte na prática dos irmãos:
  Streamable HTTP em `/mcp`.
- Review (claude.com/docs/connectors/building/review-criteria): toda
  ferramenta com `title` e `readOnlyHint: true` (o 0.12.1 tinha ZERO
  anotações); nome ≤ 64 chars; erros acionáveis; respostas de tamanho
  razoável; não gatear por `clientInfo.name`; não validar `Origin` de forma
  estrita nem bloquear o egresso da Anthropic no WAF; `initialize` < 10 s.
- Teste: `npx @modelcontextprotocol/inspector --cli <url>/mcp --transport http
  --method tools/list` e conector em Customize → Connectors.

## 3. Cloudflare Containers (developers.cloudflare.com, lido em 08/09/2026 — reconferir preços antes de criar)

| Instância | vCPU | Memória | Disco |
|---|---|---|---|
| `lite` | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | 1/2 | 4 GiB | 8 GB |

- Exige **Workers Paid (US$ 5/mês)**, que inclui 25 GiB-h de memória, 375
  vCPU-min e 200 GB-h de disco por mês; excedente US$ 0,0000025/GiB-s,
  0,000020/vCPU-s, 0,00000007/GB-s. `basic` ligado 24 h ≈ 720 GiB-h/mês ≈
  US$ 6 além do incluso; com `sleepAfter` (padrão 10 min) custa perto de zero.
- **Disco EFÊMERO**: ao dormir, a próxima partida tem disco novo → o cache de
  cubos some; cold start 1–3 s + re-download do ano pedido.
- Worker na frente é obrigatório (é ele que roteia ao container) — ganha de
  graça o que os irmãos já têm: domínio `*.sidneybissoli.com`, Analytics
  Engine, rate limit, bearer opcional.
- Região: "nearest free location"; instância única por nome
  (`getContainer(env.SIH, "sih-1")`) = cache compartilhado por todos.

## 4. Desenho

```
claude.ai ──HTTPS──▶ Worker sih-br-mcp-edge (sih.sidneybissoli.com)
                      │  rotas públicas: /, /health, /status, server card
                      │  rate limit por IP · bearer opcional · AE sih_mcp_tool_calls
                      │  Origin/Host validados aqui (spec 2025-11-25: 403)
                      └──/mcp──▶ Container (node:22-slim, dist/http.js)
                                   NodeStreamableHTTPServerTransport, STATELESS
                                   createServer() por request · DuckDB singleton
                                   cache em /data (efêmero) · população na imagem
                                   cubos sob demanda do canal público (R2, egresso 0)
```

Código: `src/tools.ts` (as 12 ferramentas + `callTool()`), `src/server.ts`
(factory `createServer()` no SDK v2: `McpServer.registerTool` com `title`,
anotações e `fromJsonSchema` sobre os JSON Schemas existentes), `src/index.ts`
(stdio, `serveStdio`), `src/http.ts` (HTTP: `/mcp` e `/healthz`). O mesmo
`callTool()` serve os dois transportes — é o que o smoke por HTTP prova.

## 5. Fases

**F1 — código (esta sessão).** Migrar para o SDK v2; factory; anotações
(`title`, `readOnlyHint`); `SERVER_VERSION` lido do package.json (estava
"0.10.0" fixo desde a 0.10.0); `src/http.ts`; scripts smoke/golden no cliente
v2; `scripts/smoke-http.mjs`. **Saída:** `smoke:stdio` passa contra o MESMO
baseline de superfície (inputSchema intocado; só título e anotações entram
fora dele), golden byte a byte, `smoke:http` responde às 3 chamadas por HTTP.

**F2 — Dockerfile + Worker de borda + deploy.** `Dockerfile` (`node:22-slim`,
`npm ci --omit=dev`, população pré-baixada na imagem); `worker/` do template
`mcp-br-commons/templates/cloudflare-worker` com o handler MCP trocado por
proxy ao container (`@cloudflare/containers`, `sleepAfter` 1 h,
`max_instances` 1). **Gate do usuário antes:** confirmar Workers Paid e o
subdomínio `sih.sidneybissoli.com`. **Saída:** Inspector lista as 12
ferramentas pela URL pública; cold start medido; série de 34 anos medida
pelo Worker.

**F3 — painel.** `host = "sih.sidneybissoli.com"` em `config.R` do monitor;
o dataset `sih_mcp_tool_calls` com os blobs do senado entra sozinho.
**Saída:** o sih aparece no painel com chamadas reais.

**F4 — conector no claude.ai + prova real.** Adicionar em Customize →
Connectors; medir o timeout do cliente com `compare_icsap_trends` 1992–2025;
se estourar, emitir `notifications/progress` por ano ou pré-agregar a série
no produtor. **Saída:** resposta correta no claude.ai; item fechado no
TAREFAS.

## 6. Riscos

- Série de 34 anos (8 s a quente, 30 s a frio) vs timeout do cliente — medir na F4; mitigação em
  duas camadas (progresso; cubo de série pronto no healthbr-data).
- Disco efêmero: cada sono re-baixa os anos pedidos; mitigação `sleepAfter`
  longo + população na imagem; se doer, pré-aquecer os anos mais pedidos.
- Sem OAuth = qualquer um chama: rate limit + `max_instances: 1` + bearer
  opcional; dado é público, o risco é custo, não vazamento.
- `fromJsonSchema` valida a entrada (ajv) — o 0.12.1 não validava; argumento
  fora do schema passa a ser recusado com `-32602` em vez de cair no handler.
  O golden cobre os argumentos válidos.
- Estado global por processo (`manifestMemo`, `popCoverageCache`, sidecars
  lidos uma vez): correto porque o dado é igual para todos; sidecar de ano
  baixado DEPOIS do arranque não entra — conferir na F2 com o cache vazio.

## 8. Execução (09/09/2026, 41ª sessão)

**F2 deploy — FEITO.** `npx wrangler deploy` em `worker/` (Docker Desktop
4.90 aberto; wrangler 4.130.0) em 72 s: Worker `sih-br-mcp-edge`, container
`sih-br-mcp-edge-sihcontainer` (`basic`, imagem 571 MB), domínio
`sih.sidneybissoli.com`. Inspector lista as 12 ferramentas pela URL pública.
O primeiro build morreu no `npm ci` da imagem com ECONNRESET aos 434 s —
transitório (repetido: 6,6 s; rede do container normal).

| Medição pela borda | Valor |
| --- | --- |
| `GET /status` (só o Worker) | 0,35 s |
| Cold start (handshake com o container dormindo) | 16,6 s |
| `tools/list` a quente | 2,9 s |
| `compare_icsap_trends` 2024–2025 por UF, cubos no disco | 25,5 s |
| `compare_icsap_trends` 1992–2025 por UF, cubos no disco | 310 s |
| idem a frio (baixa 1,5 GB de cubos antes) | conexão caiu em ~322 s sem resposta |

**Defeito 1 — memória (corrigido na 0.13.1, CONTEXT decisão 30).** A série
longa e até 2015–2025 falhavam com `Out of Memory Error: failed to offload
data block (1.5 GiB/1.5 GiB used)`: a CTE `linhas` materializada duas vezes
+ DISTINCT dos estratos não cabem em 819 MiB de DuckDB + 1,5 GiB de disco
temporário. Reproduzido em Docker local (`--memory=1g`, cubos do canal);
ano a ano passa sob 1 GiB (34 anos em 62 s a 0,5 CPU), mesmos números da
execução única sob 4 GiB. `queryIcsapAggregate` executa um ano por vez numa
tabela temporária e agrega no DuckDB. A imagem fixa `SIH_DUCKDB_THREADS=1`.

**Defeito 2 — rollout travado (corrigido).** SIGTERM no meio da série:
`shutdown()` esperava o DuckDB, o processo velho drenou ~10 min e o
container novo não subia ("The container is not running, consider calling
start()"). Agora `shutdown()` sai em 5 s.

**O que a medição diz.** A memória cabe no `basic`; o limite agora é CPU:
1/4 vCPU faz a série de 34 anos levar 5 min (5× o bench local a 0,5 CPU),
fora do alcance de qualquer timeout de cliente. Opções, decisão do usuário:
(a) instância maior (`standard-2`, 1 vCPU, 6 GiB, 12 GB: ~75 s estimados;
memória cobrada por hora ligada, 6 GiB × US$ 0,0000025/s ≈ US$ 0,054/h);
(b) `sih:serie-pre-agregada` — gravar por ano os estratos distintos (ou os
totais por chaves) no produtor (healthbr-data) ou no consumidor ao baixar o
ano: a consulta vira soma corrida, milissegundos por ano, e resolve também
a memória. (b) é a mitigação prevista no §6.

**F3 — FEITO.** `host = "sih.sidneybissoli.com"` em `config.R:47` do monitor.

**F4 — ver TAREFAS.md do monitor.**

## 7. Fora de escopo

`outputSchema`/`structuredContent` tipado por ferramenta (o bloco de
proveniência já sai como `structuredContent`); OAuth (CIMD é o preferido do
Claude se um dia for preciso); `Tasks` da spec 2025-11-25 para operação
assíncrona (cedo no cliente); escalar além de uma instância.
