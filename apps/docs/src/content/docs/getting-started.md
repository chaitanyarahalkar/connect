---
title: Getting started
description: Run Connect locally, seed a demo org, and mint your first token.
---

## Prerequisites

- Node 22 and [pnpm](https://pnpm.io) 10
- Docker (for Postgres 16 and Redis 7)

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

## Mint your first token

Your workload authenticates with **its own identity**, never a provider secret. Create a workload client on a project in the dashboard (printed once):

```bash
CONNECT_API_URL=http://localhost:4000
CONNECT_CLIENT_ID=pc_…
CONNECT_CLIENT_SECRET=pcs_…
```

```ts
import { getToken } from '@connect/sdk';

const { token } = await getToken({ connector: 'github', scopes: ['repo'] });
```

Continue with the [SDK guide](/connect/guides/sdk/) or the [core concepts](/connect/concepts/).

## Development

```bash
pnpm test                      # vitest: sdk, crypto, engine + full-stack integration suites
pnpm typecheck
pnpm lint
```

Integration tests run the API in-process against a real Postgres (`connect_test`) and Redis, driving the mock provider for complete OAuth flows — including a concurrent refresh-rotation race test.
