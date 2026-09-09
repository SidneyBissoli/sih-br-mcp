# Imagem do container do sih-br-mcp (PLAN-004): o servidor MCP por Streamable
# HTTP (dist/http.js) atrás do Worker de borda em worker/. Construída pelo
# `wrangler deploy` a partir de worker/wrangler.jsonc (image: ../Dockerfile).
#
# Duas etapas: a primeira compila e poda as devDependencies; a segunda leva só
# node_modules de produção, dist/ e a população pré-baixada. O disco do
# container é EFÊMERO (cada sono = disco novo), por isso a população (13 MB,
# necessária às ferramentas de taxa) vai na imagem; os cubos por ano (23–72 MB)
# ficam sob demanda, baixados do canal público no primeiro uso.

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
    SIH_CACHE_DIR=/data/cubos
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/warm-cache.mjs ./scripts/
# População na imagem; cubos sob demanda. Para pré-aquecer anos na imagem
# (custa tamanho de imagem, poupa cold start): --build-arg WARM_YEARS=2024,2025
ARG WARM_YEARS=""
RUN node scripts/warm-cache.mjs --years "$WARM_YEARS"
EXPOSE 8080
CMD ["node", "dist/http.js"]
