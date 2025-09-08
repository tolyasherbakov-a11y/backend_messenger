# ──────────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile для API (Fastify, TypeScript)
# Предполагается, что каталог сборки — apps/api (см. docker-compose.yml)
# ──────────────────────────────────────────────────────────────────────────────

# Этап 1: базовый Node с pnpm
FROM node:20-alpine AS base
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate
WORKDIR /app

# Этап 2: установка зависимостей (prod + dev для сборки TS)
FROM base AS deps
WORKDIR /app
# Если вы используете монорепо с workspace-зависимостями,
# убедитесь, что package.json включает все необходимые deps для standalone-сборки api.
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
RUN pnpm install --frozen-lockfile

# Этап 3: сборка TypeScript
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Этап 4: образ исполнения (минимум)
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Тонкий юзер
RUN addgroup -S app && adduser -S app -G app
USER app

# Копируем production-зависимости
COPY --chown=app:app package.json pnpm-lock.yaml ./
# Устанавливаем только прод-зависимости
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate && pnpm fetch --prod && pnpm install --prod --frozen-lockfile

# Копируем сборку
COPY --chown=app:app --from=build /app/dist ./dist

# Порт и команда
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/main.js"]
