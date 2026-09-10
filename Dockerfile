# Imagem do container do sih-br-mcp (PLAN-004): o servidor MCP por Streamable
# HTTP (dist/http.js) atrás do Worker de borda em worker/. Construída pelo
# `wrangler deploy` a partir de worker/wrangler.jsonc (image: ../Dockerfile).
#
# Duas etapas: a primeira compila e poda as devDependencies; a segunda leva só
# node_modules de produção, dist/ e o cache pré-aquecido. O disco do container é
# EFÊMERO (cada sono = disco novo), então tudo que é PEQUENO e SEMPRE PEDIDO vai
# na imagem, e o que é grande e sob demanda fica no canal:
#
#   na imagem (98 MB)   população (13 MB), 34 sidecars de proveniência (9,7 MB),
#                       os dois resumos (845 KB) e os 68 estratos por ano
#                       (18,8 MB de causas + 59,0 MB de ICSAP)
#   sob demanda         cubos por ano (23–72 MB), que somam 1.644 MB nos 34 anos
#
# Os SIDECARS entraram em 10/09/2026 e foram o maior ganho: eram 9,7 dos 10,3 MB
# do custo frio da série de 34 anos — muitos, pequenos, sempre pedidos (é deles
# que saem as notas de era) e baixados em SÉRIE. Medido nesta imagem, com os
# limites do `basic` (`docker run --memory=1g --cpus=0.25`) e container
# recém-nascido nos dois casos: a série de 34 anos caiu de 13,4 s (baixando
# 10,3 MB) para 2,5 s (sem baixar nada), com a mesma resposta.
#
# Os ESTRATOS entraram logo depois, pela mesma razão medida: eles são POR ANO, e
# a pergunta demográfica na série longa ("a internação de idosos mudou desde
# 1992?") baixava os 34 de uma vez. Medido do mesmo jeito: 14,0 s para 2,8 s,
# mesma resposta (91.189.298 internações de 60 anos ou mais em 34 anos). Ver
# scripts/warm-cache.mjs para o porquê de cada item e para --skip-estratos, que
# devolve a imagem ao tamanho anterior.
#
# TAMANHO, e como medir. `docker images` e `docker history` dão totais
# diferentes para esta imagem de dois estágios; o número reprodutível é
# `docker image inspect <tag> --format '{{.Size}}'`. Por ele: 132 MB antes dos
# sidecars, 145,6 MB com eles, 222,9 MB com os estratos. As três contagens
# discordam no absoluto e concordam no delta — o que entra é o que warm-cache
# baixa, nem um byte a mais.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# `npm ci` roda `prepare` (= tsc) e compila dist/; depois sobra só produção.
RUN npm ci && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    SIH_HTTP_HOST=0.0.0.0 \
    SIH_CACHE_DIR=/data/cubos \
    SIH_DUCKDB_THREADS=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/warm-cache.mjs ./scripts/
# Para assar também os CUBOS de anos específicos (custa tamanho de imagem,
# poupa o download deles a frio): --build-arg WARM_YEARS=2024,2025
ARG WARM_YEARS=""
RUN node scripts/warm-cache.mjs --years "$WARM_YEARS"
EXPOSE 8080
CMD ["node", "dist/http.js"]
