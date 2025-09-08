# ──────────────────────────────────────────────────────────────────────────────
# Dockerfile для воркера очистки медиа (GC сирот/просроченных/карантина)
# Сборка standalone внутри каталога apps/workers/media-gc
# ──────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS base
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
WORKDIR /app

# Зависимости
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
RUN pnpm install --frozen-lockfile

# Сборка TS
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
USER app

COPY --chown=app:app package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate \
    && pnpm fetch --prod \
    && pnpm install --prod --frozen-lockfile

COPY --chown=app:app --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]
