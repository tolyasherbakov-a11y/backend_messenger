# ──────────────────────────────────────────────────────────────────────────────
# Realtime WebSocket Gateway — production Dockerfile
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# tini для корректного PID1; curl для healthcheck
RUN apk add --no-cache tini curl \
 && corepack enable \
 && corepack prepare pnpm@9.7.1 --activate

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
RUN pnpm install --frozen-lockfile

# ── build (TS → JS) ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini curl \
 && addgroup -S app && adduser -S app -G app
USER app

COPY --chown=app:app package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate \
 && pnpm fetch --prod \
 && pnpm install --prod --frozen-lockfile

COPY --chown=app:app --from=build /app/dist ./dist

ENV PORT=8081
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
