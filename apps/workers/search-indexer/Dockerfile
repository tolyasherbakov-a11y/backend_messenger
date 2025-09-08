# ──────────────────────────────────────────────────────────────────────────────
# Dockerfile: Search Indexer Worker (OpenSearch client + Node.js)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini curl \
 && corepack enable && corepack prepare pnpm@9.7.1 --activate

# deps
FROM base AS deps
WORKDIR /app
COPY package.json ./
RUN pnpm install

# build
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini curl \
 && addgroup -S app && adduser -S app -G app
USER app

COPY --chown=app:app package.json ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate && pnpm install --prod

COPY --chown=app:app --from=build /app/dist ./dist

EXPOSE 9092
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD curl -fsS http://127.0.0.1:9092/healthz || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
