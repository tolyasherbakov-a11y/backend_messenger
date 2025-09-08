# Backend Messenger — Monorepo

Production‑ready Fastify API, realtime WS gateway, and workers for media/search. Uses pnpm workspaces and TypeScript.

## Prerequisites

- Node.js 20+
- pnpm 9 (Corepack is enabled in Dockerfiles)
- Docker + Docker Compose (for local infra)

## Install & Build

```bash
pnpm install
pnpm -r build
```

This compiles all packages, modules, apps (API, realtime) and workers to `dist/`.

## Run API locally

```bash
pnpm --filter api dev
# or production
pnpm --filter api start
```

Environment variables are documented in `.env.example`. Copy it to `.env` and adjust as needed.

## Run Infra (Postgres, Redis, MinIO, ClamAV, OpenSearch)

```bash
docker compose -f infra/docker-compose.yml up -d
# Optional realtime gateway
docker compose -f infra/docker-compose.yml -f infra/docker-compose.realtime.yml up -d
```

Services:
- API on `:8080` (docs at `/docs`, spec at `/openapi.json`)
- Postgres `:5432`, Redis `:6379`, MinIO `:9000/9001`
- OpenSearch `:9200` (for search-indexer)

## Realtime WS

```bash
pnpm --filter realtime build && pnpm --filter realtime start
```

WS endpoint: `GET /ws` with Bearer JWT (HS256) or HMAC headers.

## Workers

Workers live in `apps/workers/*` and are built similarly. Dockerfiles are provided; you can run them via Docker Compose or directly with Node after building:

```bash
pnpm --filter worker-search-indexer build && pnpm --filter worker-search-indexer start
```

## Notes

- Path aliases are configured in `tsconfig.base.json` (e.g. `@modules/*`, `@config/*`).
- Metrics plugin exposes `/metrics`; health at `/healthz`, readiness at `/readyz`.
- Security/rate‑limit/OpenAPI are registered centrally in `apps/api/src/main.ts` via plugins.
