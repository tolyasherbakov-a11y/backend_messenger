# ──────────────────────────────────────────────────────────────────────────────
# Dockerfile для notify-воркера (вебхуки/пуш/внутренние нотификации)
# Сборка standalone внутри каталога apps/workers/notify
# ──────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini curl \
 && corepack enable \
 && corepack prepare pnpm@9.7.1 --activate

# Зависимости
FROM base AS deps
WORKDIR /app
COPY package.json ./
RUN pnpm install

# Сборка TS
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY index.ts ./index.ts
RUN pnpm build

# Runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini curl \
 && addgroup -S app && adduser -S app -G app
USER app

COPY --chown=app:app package.json ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate && pnpm install --prod

COPY --chown=app:app --from=build /app/dist ./dist

EXPOSE 9091
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD curl -fsS http://127.0.0.1:9091/healthz || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node", "dist/index.js"]
