---
title: Core concepts
description: How Connect brokers credentials — primitives, token flow, and the monorepo layout.
---

Connect lets your code call third-party APIs without ever holding long-lived provider secrets: register a *connector* per provider, authorize it once, and request **short-lived, scoped tokens at runtime**. Inbound, Connect verifies provider webhooks and fans them out to your services with its own signature (*triggers*).

## How it works

```
                     ┌───────────────────────────── Connect ─────────────────────────────┐
 your service ──────▶│ POST /v1/tokens                                                   │
 (OIDC workload      │   authenticate caller → check project link + environment          │
  identity or PAT)   │   → resolve installation → encrypted Redis cache → single-flight  │──▶ provider
                     │   refresh (rotation-safe) → meter usage → short-lived token       │    (OAuth/API key)
                     └───────────────────────────────────────────────────────────────────┘
 provider webhooks ─▶│ verify HMAC signature → store → fan out signed to destinations    │──▶ your endpoints
                     └───────────────────────────────────────────────────────────────────┘
```

## Primitives

| Primitive | What it is |
|---|---|
| **Connector** | Org-owned record for one provider: `api_key`, generic `oauth2` (PKCE), or `github`/`slack` presets |
| **Installation** | One tenant's grant (workspace, org, or individual user) — a connector serves many |
| **Token** | Short-lived credential minted per request; subjects: `app`, `user`, `jwt-bearer` |
| **Project link** | Binds a connector to a project, per environment (production/preview/development) |
| **Trigger** | Verified inbound webhook, forwarded to your destinations with a `connect-signature` |
| **Auth** | Two legs: caller → Connect (OIDC workload JWT / PAT / session), Connect → provider (OAuth/API key) |

## Two legs of authentication

1. **Caller → Connect.** Deployments exchange client credentials for a 10-minute ES256 JWT from Connect's own issuer (JWKS at `/.well-known/jwks.json`). Dashboards use sessions; automation uses personal access tokens (`cn_pat_…`). Workload identities can *only* mint tokens — they cannot touch the control plane.
2. **Connect → provider.** OAuth grants and API keys live envelope-encrypted in Connect. Tokens are minted per request, cached encrypted in Redis, and refreshed under a row lock so rotating refresh tokens are never lost to a race.

## Monorepo

| Path | Package | What |
|---|---|---|
| `apps/api` | `@connect/api` | Hono API: token service, OAuth engine, webhook ingest + BullMQ delivery worker |
| `apps/dashboard` | `@connect/dashboard` | Next.js dashboard: connector wizard, installations, links, playground, usage |
| `apps/mock-provider` | `@connect/mock-provider` | In-repo OAuth provider for tests/demo — no real provider apps needed |
| `apps/docs` | `@connect/docs` | This documentation site (Astro Starlight) |
| `packages/db` | `@connect/db` | Drizzle schema + migrations (Postgres) |
| `packages/crypto` | `@connect/crypto` | Envelope encryption, secret hashing, ES256 JWT issuer |
| `packages/shared` | `@connect/shared` | Zod schemas, error codes, redaction |
| `packages/connectors` | `@connect/connectors` | Provider quirks + GitHub/Slack presets (config, not code) |
| `packages/sdk` | `@connect/sdk` | `Connect` client with refresh-ahead caching + typed errors |
| `packages/cli` | `@connect/cli` | `connect` CLI |

Next: the [architecture deep dive](/connect/reference/architecture/) traces a token request through the API.
