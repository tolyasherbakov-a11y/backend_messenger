FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini \
 && corepack enable \
 && corepack prepare pnpm@9.7.1 --activate

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
RUN apk add --no-cache tini \
 && addgroup -S app && adduser -S app -G app
USER app
COPY --chown=app:app package.json ./
RUN corepack enable && corepack prepare pnpm@9.7.1 --activate && pnpm install --prod
COPY --chown=app:app --from=build /app/dist ./dist
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]

