# ──────────────────────────────────────────────────────────────────────────────
# Dockerfile для notify-воркера (вебхуки/пуш/внутренние нотификации)
# Сборка standalone внутри каталога apps/workers/notify
# ──────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS base
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
WORKDIR /app

# Зависимости
FROM base AS deps
WORKDIR /app
COPY package.json ./
RUN pnpm install

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

COPY --chown=app:app package.json ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate && pnpm install --prod

COPY --chown=app:app --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]
