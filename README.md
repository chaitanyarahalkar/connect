# Connect

**A credential broker for agents and services.** Connect lets your code call third-party APIs without ever holding long-lived provider secrets: register a *connector* per provider, authorize it once, and request **short-lived, scoped tokens at runtime**. Inbound, Connect verifies provider webhooks and fans them out to your services with its own signature (*triggers*).

Inspired by [Vercel Connect](https://vercel.com/docs/connect), built as a standalone platform.

```ts
import { getToken } from '@connect/sdk';

// no secrets in env vars — a short-lived token, minted on demand
const { token } = await getToken({ connector: 'github', scopes: ['repo'] });
```

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

Six primitives:

| Primitive | What it is |
|---|---|
| **Connector** | Org-owned record for one provider: `api_key`, generic `oauth2` (PKCE), or `github`/`slack` presets |
| **Installation** | One tenant's grant (workspace, org, or individual user) — a connector serves many |
| **Token** | Short-lived credential minted per request; subjects: `app`, `user`, `jwt-bearer` |
| **Project link** | Binds a connector to a project, per environment (production/preview/development) |
| **Trigger** | Verified inbound webhook, forwarded to your destinations with a `connect-signature` |
| **Auth** | Two legs: caller → Connect (OIDC workload JWT / PAT / session), Connect → provider (OAuth/API key) |

## Monorepo

| Path | Package | What |
|---|---|---|
| `apps/api` | `@connect/api` | Hono API: token service, OAuth engine, webhook ingest + BullMQ delivery worker |
| `apps/dashboard` | `@connect/dashboard` | Next.js dashboard: connector wizard, installations, links, playground, usage |
| `apps/mock-provider` | `@connect/mock-provider` | In-repo OAuth provider for tests/demo — no real provider apps needed |
| `packages/db` | `@connect/db` | Drizzle schema + migrations (Postgres) |
| `packages/crypto` | `@connect/crypto` | Envelope encryption, secret hashing, ES256 JWT issuer |
| `packages/shared` | `@connect/shared` | Zod schemas, error codes, redaction |
| `packages/connectors` | `@connect/connectors` | Provider quirks + GitHub/Slack presets (config, not code) |
| `packages/sdk` | `@connect/sdk` | `getToken()` with refresh-ahead caching + typed errors |
| `packages/cli` | `@connect/cli` | `connect` CLI |

## Quickstart

```bash
pnpm install
docker compose up -d                 # postgres 16 + redis 7
cp .env.example .env                 # then fill CONNECT_MASTER_KEY + BETTER_AUTH_SECRET:
                                     #   openssl rand -base64 32
pnpm db:migrate
pnpm db:seed                         # demo org + connectors + a PAT (printed once)
pnpm dev                             # api :4000, dashboard :3000, mock provider :4100
```

Then either open the dashboard at `http://localhost:3000` (sign up, create an org), or run the full self-verifying demo:

```bash
pnpm demo
```

The demo boots the API + mock provider over real HTTP and walks every flow — api-key tokens, the OAuth authorize→callback dance (PKCE), cache hits, rotating refresh, workload identity, and signed webhook delivery.

## Using the SDK

Your workload authenticates with **its own identity**, never a provider secret:

```bash
# printed once when you create a client on a project in the dashboard
CONNECT_API_URL=http://localhost:4000
CONNECT_CLIENT_ID=pc_…
CONNECT_CLIENT_SECRET=pcs_…
```

```ts
import { getToken, UserAuthorizationRequiredError } from '@connect/sdk';

// act as your app
const app = await getToken({ connector: 'slack-main', scopes: ['chat:write'] });

// act as a specific user who authorized earlier
try {
  const user = await getToken({
    connector: 'github',
    subject: { type: 'user', userId: 'user_123' },
  });
} catch (err) {
  if (err instanceof UserAuthorizationRequiredError) {
    // send them through the connector's authorize flow
  }
}
```

The SDK caches in-process, refreshes ahead of expiry in the background, de-dupes concurrent calls, and retries 5xx/429 with jitter. Tokens are also cached server-side (encrypted, in Redis) so a fleet of instances shares mints.

## CLI

```bash
connect login                 # paste a PAT
connect connectors list
connect connectors create
connect link demo-app slack-main --env production,preview
connect authorize slack-main  # prints the consent URL
connect token slack-main --scopes chat:write
```

## Security model

- **Envelope encryption at rest** — every stored secret (API keys, OAuth client secrets, refresh tokens, signing keys) gets its own AES-256-GCM data key, wrapped by a master key (`CONNECT_MASTER_KEY`, KMS-ready `KeyProvider` interface). AAD binds each ciphertext to its row, so ciphertexts can't be swapped between records. Key versions enable rotation.
- **No plaintext bearer secrets in the DB** — PATs and workload client secrets are stored as SHA-256 hashes; shown exactly once at creation.
- **Workload identity** — deployments exchange client credentials for a 10-minute ES256 JWT from Connect's own issuer (JWKS at `/.well-known/jwks.json`). Token requests are authorized against project links *and* the environment baked into the JWT. Workloads cannot touch the control plane.
- **Rotation-safe refresh** — provider refreshes run under a row lock with single-flight de-dup, so a rotating refresh token (Slack-style) can't be lost to a race. Superseded grants are kept for forensics.
- **Webhooks** — inbound: per-connector random ingest path + provider HMAC verification (GitHub `X-Hub-Signature-256`, Slack `v0` with replay window, generic HMAC); invalid signatures are stored flagged but never forwarded. Outbound: every delivery is signed with a per-trigger `whsec_` secret.
- **Metering & audit** — every token issuance and delivery is metered (`usage_events`) and recorded (`token_issuances`, `audit_logs`) without ever storing token material.

## Development

```bash
pnpm test                      # vitest: crypto, engine, signature + full-stack integration suites
pnpm typecheck
pnpm --filter @connect/api test
```

Integration tests run the API in-process (`app.request`) against a real Postgres (`connect_test`) and Redis, driving the mock provider for complete OAuth flows — including a concurrent refresh-rotation race test.

## Roadmap

- KMS `KeyProvider` (AWS/GCP) and master-key rotation job
- Installation-scoped rate limits and per-connector token policies
- More managed presets (Google, Salesforce, Snowflake JWT exchange)
- Delivery replay UI + dead-letter drains
- Billing integration on top of `usage_events`
