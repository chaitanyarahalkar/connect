---
title: Architecture
description: How a token request flows through the API — auth, service, minters, cache — plus the OAuth engine and webhook pipeline.
sidebar:
  order: 1
---

The API (`apps/api`) is a Hono app. Public routes: `/health`, session auth, OIDC discovery/JWKS/token, the OAuth callback, and webhook ingest. Everything else lives under `/v1` behind the auth middleware. The webhook delivery worker (BullMQ) runs in the same process.

## Token request flow

```
POST /v1/tokens
  → auth middleware        (session cookie | cn_pat_… hash lookup | workload JWT verify)
  → resolve connector      (org-scoped, must be active)
  → authorize request      (workloads: project link must include the JWT's environment)
  → resolve installation   (explicit id | user's installation | the single active one)
  → Redis token cache      (envelope-encrypted; hit → return)
  → single-flight mint     (Redis lock; losers poll, winner mints)
  → provider minter        (api_key | oauth2 | github | slack)
  → cache + meter + audit  (token_issuances, usage_events — never the token itself)
```

**Auth middleware** (`src/auth/middleware.ts`) resolves the principal: no header → dashboard session; `Bearer cn_pat_…` → PAT (SHA-256 hash lookup, revocation/expiry checks); any other bearer → workload JWT verified against Connect's own issuer. Workload principals can only mint tokens; role checks (`member` < `admin` < `owner`) gate the control plane.

**Token service** (`src/tokens/service.ts`) orchestrates the flow above. `jwt-bearer` subjects bypass the cache entirely. The cache key is `tok:{connector}:{installation}:{subject}:{sha256(scopes+resource)}`.

**Minters** (`src/tokens/*`):

- `api_key` — returns the stored key for `app` subjects with a policy TTL.
- `oauth2`/`slack` — **rotation-safe refresh**: `SELECT … FOR UPDATE` on the current refresh grant, refresh via the engine, and if the provider rotated, insert the new grant + supersede the old one in the same transaction. `invalid_grant` marks the installation `pending` and raises `grant_expired`.
- `github` — GitHub App mode mints installation access tokens with a short-lived RS256 app JWT (narrowed by `authorizationDetails`); otherwise falls through to the OAuth minter.

**Token cache** (`src/tokens/cache.ts`) stores envelope-encrypted tokens in Redis with the cache key as AAD, a 60s clock-skew allowance, and a 5s minimum-TTL floor. **Single-flight** (`src/tokens/lock.ts`) uses `SET NX EX 30`; losers poll every 200ms up to 8s; release is a compare-and-delete Lua script.

## OAuth engine

`src/oauth/engine.ts` is pure functions with an injected `fetch`: `buildAuthorizationUrl` (PKCE S256 when enabled, provider quirks merged), `exchangeCode`, `refreshGrant`, `exchangeJwtBearer`, `revokeToken`, and OIDC `discover`. Client auth is HTTP Basic or form-body per connector config.

The flow: `POST /v1/connectors/:id/authorize` stores single-use state in Redis (`GETDEL`, 10-minute TTL, carries the PKCE verifier) and returns the consent URL → the provider redirects to `GET /v1/oauth/callback` → code exchange → the provider quirk labels the installation (userinfo / `team.name` / GitHub login) → installation upserted and the grant stored (superseding any prior grant transactionally) → redirect back to the dashboard.

## Webhook pipeline

**Ingest** (`src/webhooks/ingest.ts`): `POST /v1/webhooks/:connectorId/:ingestKey` — timing-safe ingest-key check → provider HMAC verification → JSON parse (Slack `url_verification` answered inline) → dedup on the provider delivery id (unique index) → store in `webhook_events` → if the signature was invalid, stop with 401 (stored, never forwarded) → else insert one `webhook_deliveries` row per matching active trigger and enqueue BullMQ jobs.

**Delivery worker** (`src/webhooks/queue.ts`): concurrency 5; decrypts the per-trigger `whsec_` secret, POSTs the payload with `connect-signature` (+ event id/type/connector headers); non-2xx throws so BullMQ retries (5 attempts, exponential backoff base 10s); terminal failures are marked `dead`, successes metered.

## Crypto foundations

`packages/crypto`: AES-256-GCM envelope encryption (per-secret data key wrapped by the master KEK, AAD = `table:rowId:kind`), SHA-256 secret hashing with 12-char prefixes for identification, and an ES256 `JwtSigner` with JWKS output. Signing keys are themselves envelope-encrypted rows; the issuer creates one lazily on first use (10-minute workload tokens, audience `connect`).
