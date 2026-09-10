# Worker de borda do sih-br-mcp (`sih-br-mcp-edge`)

Cloudflare Worker que fica na frente de um **Cloudflare Container** rodando o
servidor MCP do SIH/SUS por Streamable HTTP (`dist/http.js`, imagem do
`../Dockerfile`). O DuckDB nativo não roda no isolate do Worker; o Worker faz o
que os irmãos do portfólio já fazem na borda e **encaminha o `/mcp` ao
container**. Instância do template `mcp-br-commons/templates/cloudflare-worker`
("se copia, não se importa"); desenho em `../docs/plan-004-servidor-remoto.md`.

```
claude.ai ──HTTPS──▶ Worker sih-br-mcp-edge (sih.sidneybissoli.com)
                      │  /, /health, /status, /metrics, server card — públicas
                      │  Host/Origin (403) · bearer opcional · rate limit por IP
                      │  Analytics Engine sih_mcp_tool_calls · UsageTracker
                      └──/mcp──▶ Container SihContainer (basic, 1 instância, dorme após 1 h)
                                   dist/http.js na porta 8080: /mcp e /healthz
```

## Rotas

| Rota | O quê | Arquivo |
|---|---|---|
| `/` | Landing page (identificação, contato, as 12 ferramentas) | `src/landing.ts` |
| `/robots.txt`, `/sitemap.xml`, `/<chave>.txt` | Descoberta / IndexNow | `src/discovery.ts` |
| `/health` | Worker de pé + sonda do `/healthz` do container (`container: "up" \| "asleep" \| "down"`, timeout 3 s). **Não acorda** o container: "asleep" é o estado normal fora de uso. Monitores externos devem usar esta rota, não o `/mcp`. | `src/index.ts`, `src/container.ts` |
| `/status` | Versão + id/tag/timestamp do último deploy | `src/status.ts` |
| `/metrics` | Estatísticas de uso agregadas (30 dias, Durable Object) | `src/usage.ts` |
| `/.well-known/mcp/server-card.json` | Server card: ferramentas lidas do container (cache por isolate); lista estática se ele não responde (`source: "static"`) | `src/card.ts` |
| `/.well-known/glama.json` | Descritor do Glama | `src/index.ts` |
| `/mcp` | **Proxy** ao container: POST/GET/DELETE, corpo e resposta em stream (SSE de até ~30 s), cabeçalhos do transporte por lista positiva | `src/index.ts`, `src/mcp-proxy.ts` |

No `/mcp`, antes de auth e rate limit: `Host` fora de `SERVER_CONFIG.allowedHostnames`
→ 403; `Origin` de navegador que não seja o próprio host, `localhost` ou a lista
`ALLOWED_ORIGIN` → 403. Requisição **sem** `Origin` (conector do claude.ai,
Claude Code, Inspector CLI) passa. O container não valida nada disso — só o
Worker fala com ele.

Telemetria por chamada (`src/analytics.ts`, mesmo esquema dos irmãos): para
`tools/call`, `tool = params.name`; para outros métodos, `tool = method`;
desfecho `ok` se o HTTP do container < 400, `error` senão. **Limitação:** erro
JSON-RPC que viaja dentro do SSE com HTTP 200 conta como `ok`.

## Variáveis e secrets

| Nome | Tipo | Efeito |
|---|---|---|
| `API_KEY` | secret (`wrangler secret put API_KEY`) | Bearer obrigatório no `/mcp`. Ausente = acesso aberto (o claude.ai aceita servidor sem OAuth). |
| `SELF_MARKER` | secret | Requisições com header `x-mcp-self` igual a ele ganham `blob4="self"` na telemetria. |
| `ALLOWED_ORIGIN` | var (`wrangler.jsonc`) | Origins de navegador extras (vírgula); `"*"` abre para qualquer. Padrão vazio. |

## Deploy

Pré-requisitos: **Workers Paid** (Containers exigem), o subdomínio
`sih.sidneybissoli.com` na zona, **Docker rodando** na máquina e o
`../Dockerfile` na raiz do repositório (construído a partir de `dist/`, então
`npm run build` na raiz antes).

```powershell
cd worker
npm install
npm run typecheck
npm test
npx wrangler deploy
```

`wrangler deploy` sobe o Worker e, em seguida, **constrói a imagem localmente
com Docker** a partir do `image` do `wrangler.jsonc` (`../Dockerfile`; contexto
de build = pasta do Dockerfile = raiz do repo) e a envia ao registro da
Cloudflare — não há build remoto pelo `deploy`
([Image management](https://developers.cloudflare.com/containers/guides/image-management/),
[Deploy](https://developers.cloudflare.com/containers/guides/deploy/)). O
primeiro deploy leva alguns minutos provisionando a imagem; o Worker responde
antes de o `/mcp` funcionar. Alternativa sem Docker no deploy: construir e
publicar a imagem em CI (`wrangler containers build -p`) e apontar `image` para
`registry.cloudflare.com/<conta>/<imagem>:<tag>`.

Nenhum recurso precisa ser criado à mão: a migration `v1` provisiona os Durable
Objects `SihContainer` e `UsageTracker`; o dataset do Analytics Engine nasce no
primeiro `writeDataPoint`.

Dev local: `npm run dev` (também exige Docker; a imagem é construída no
arranque e reconstruída com `[r]`).

## Custo estimado (PLAN-004 §3, preços lidos em 08/09/2026 — reconferir)

- Workers Paid: US$ 5/mês, com 25 GiB-h de memória, 375 vCPU-min e 200 GB-h de
  disco inclusos.
- `basic` (1/4 vCPU, 1 GiB, 4 GB) ligado 24 h ≈ 720 GiB-h/mês ≈ US$ 6 além do
  incluso; com `sleepAfter = 1h` e uso esporádico, perto de zero.
- Disco **efêmero**: ao dormir, o cache some. Desde 10/09/2026 a imagem já traz
  o que TODA chamada precisa e é pequeno — população (13 MB), os 34 sidecars de
  proveniência (9,7 MB, de onde saem as notas de era) e os dois resumos
  pré-agregados (845 KB) —, então a série longa responde a frio sem baixar
  nada: 2,5 s contra 13,4 s antes, medido na imagem sob os limites do `basic`.
  O que sobra para o canal são os cubos por ano (23–72 MB) e os estratos do
  grão B, pedidos sob demanda (R2, egresso 0). Ver `../scripts/warm-cache.mjs`.

## Testes

`npm test` (vitest, sem rede nem container): auth, rate limit, descoberta,
landing, status, usage-core, analytics, proxy (Host/Origin/CORS/cabeçalhos/nome
da tool), server card com container falso, e a sincronia da lista de
ferramentas e da identidade com `../src/tools.ts`, `../src/server.ts`,
`../package.json` e `../server.json`.
