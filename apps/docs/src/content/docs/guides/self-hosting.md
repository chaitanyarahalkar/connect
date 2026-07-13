---
title: Self-hosting
description: Run Connect yourself — Docker Compose, environment reference, migrations, and Railway deploys.
sidebar:
  order: 6
---

Connect is three deployables — the API (Hono, includes the webhook delivery worker in-process), the dashboard (Next.js), and optionally the mock provider for testing — backed by Postgres 16 and Redis 7.

## Local infrastructure

`docker-compose.yml` provides the data stores:

| Service | Image | Port | Notes |
| --- | --- | --- | --- |
| postgres | `postgres:16-alpine` | 5432 | user/pass/db `connect`, healthcheck `pg_isready` |
| redis | `redis:7-alpine` | 6379 | healthcheck `redis-cli ping` |

```bash
docker compose up -d
pnpm db:migrate     # drizzle migrations (packages/db)
pnpm db:seed        # optional: demo org, connectors, PAT (printed once)
```

## Environment reference

### API (`apps/api`)

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection | `postgres://connect:connect@localhost:5432/connect` |
| `REDIS_URL` | Redis (token cache, locks, BullMQ) | `redis://localhost:6379` |
| `CONNECT_MASTER_KEY` | **Required.** Base64 32-byte KEK for envelope encryption (`openssl rand -base64 32`) | — (throws if missing) |
| `CONNECT_ISSUER` | Issuer URL for workload OIDC + auth base URL | `http://localhost:4000` |
| `PORT` / `API_PORT` | Listen port (`PORT` wins) | `4000` |
| `DASHBOARD_URL` | CORS origin, trusted origin, OAuth redirect base | `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | Session signing secret | dev-only fallback — **set in production** |
| `API_KEY_TOKEN_TTL` | TTL (seconds) for api_key connector tokens | `900` |
| `LOG_LEVEL` | pino log level | `info` |
| `GITHUB_API_URL` | GitHub API base (GitHub App minting) | `https://api.github.com` |

### Dashboard (`apps/dashboard`)

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_CONNECT_API_URL` | Public API origin (browser fetches, displayed callback/ingest URLs) | `http://localhost:4000` |
| `NEXT_PUBLIC_USE_API_PROXY` | `'true'` proxies `/v1/*` and `/api/auth/*` same-origin so session cookies stay first-party | unset |
| `CONNECT_API_URL` | Rewrite destination when proxying | falls back to the public URL |
| `PORT` | `next start` port | `3000` |

### SDK / CLI consumers

`CONNECT_API_URL`, plus one credential: `CONNECT_OIDC_TOKEN`, `CONNECT_CLIENT_ID`+`CONNECT_CLIENT_SECRET`, or `CONNECT_ACCESS_TOKEN` — see [Using the SDK](/connect/guides/sdk/#authentication).

## Migrations and seeding

`packages/db` (Drizzle ORM):

```bash
pnpm db:migrate                          # applies packages/db/drizzle/*.sql
pnpm db:seed                             # demo org, api_key + mock-oauth connectors, PAT
pnpm --filter @connect/db generate       # regenerate migrations after schema changes
```

The seed requires `CONNECT_MASTER_KEY` (it encrypts connector secrets) and is safe to re-run — it skips if the `demo` org already exists.

## Railway

Both apps ship Dockerfiles and Railway configs:

- **`railway.api.json`** — builds `apps/api/Dockerfile`; healthcheck `GET /health` (300s timeout); restarts `ON_FAILURE` (max 3).
- **`railway.dashboard.json`** — builds `apps/dashboard/Dockerfile`; restarts `ON_FAILURE` (max 3).

Point both at the same Postgres/Redis add-ons, set the env vars above (`CONNECT_ISSUER` and `DASHBOARD_URL` to the public URLs), and run migrations as a release step.

## Verifying an install

```bash
pnpm demo
```

boots the API and mock provider over real HTTP and self-verifies every flow: api-key tokens, the full PKCE authorize→callback dance, cache hits, forced refresh with rotation, workload identity under project-link enforcement, and signed webhook delivery to a local receiver.
