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
pnpm --filter worker-notify build && pnpm --filter worker-notify start
```

## Uploads (S3 Multipart) — curl examples

1) Initiate upload

```bash
curl -X POST http://localhost:8080/v1/upload/initiate \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"filename":"video.mp4","mime":"video/mp4","sizeBytes":10485760}'
# => { mediaId, key, uploadId, partSize }
```

2) Presign part URLs (e.g. parts 1..3)

```bash
curl -X POST http://localhost:8080/v1/upload/<mediaId>/parts \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"key":"<key>","uploadId":"<uploadId>","parts":[1,2,3]}'
# => { parts: [ { partNumber, url }, ... ] }
```

3) PUT each part to S3 (MinIO) using the presigned URL

```bash
curl -X PUT "<presigned_url_for_part_1>" --data-binary @./part1.bin
curl -X PUT "<presigned_url_for_part_2>" --data-binary @./part2.bin
curl -X PUT "<presigned_url_for_part_3>" --data-binary @./part3.bin
```

4) Complete upload (provide partNumber + ETag list returned by S3)

```bash
curl -X POST http://localhost:8080/v1/upload/<mediaId>/complete \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <unique-key>" \
  -d '{
    "key":"<key>",
    "uploadId":"<uploadId>",
    "parts":[{"partNumber":1,"etag":"\"<etag1>\""},{"partNumber":2,"etag":"\"<etag2>\""}]
  }'
```

5) Abort upload (if needed)

```bash
curl -X DELETE http://localhost:8080/v1/upload/<mediaId> \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"key":"<key>","uploadId":"<uploadId>"}'
```

## Notify Worker — Redis stream

- Stream: `q:notify`, Group: `g:notify`
- Publish example (redis-cli):

```bash
redis-cli -u redis://localhost:6379/0 XADD q:notify * json '{"userId":"<uuid>","kind":"message","title":"New message"}'
```

Notify worker drains the stream and logs delivery intents; extend with email/push providers as needed.

## Notes

- Path aliases are configured in `tsconfig.base.json` (e.g. `@modules/*`, `@config/*`).
- Metrics plugin exposes `/metrics`; health at `/healthz`, readiness at `/readyz`.
- Security/rate‑limit/OpenAPI are registered centrally in `apps/api/src/main.ts` via plugins.
