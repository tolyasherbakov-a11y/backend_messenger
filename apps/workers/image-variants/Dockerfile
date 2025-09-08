# ──────────────────────────────────────────────────────────────────────────────
# Dockerfile: Image Variants Worker (sharp + Node.js)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app
# sharp требует libc6-compat; также tini для корректного PID1
RUN apk add --no-cache libc6-compat tini \
 && corepack enable && corepack prepare pnpm@9.7.1 --activate

# Dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch
RUN pnpm install --frozen-lockfile

# Build (TS → JS)
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Runtime
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache libc6-compat tini \
 && addgroup -S app && adduser -S app -G app
USER app

COPY --chown=app:app package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate \
 && pnpm fetch --prod \
 && pnpm install --prod --frozen-lockfile

COPY --chown=app:app --from=build /app/dist ./dist

ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
