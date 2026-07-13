---
title: HTTP API
description: Route reference for the Connect API — public endpoints and the authenticated /v1 control plane.
sidebar:
  order: 2
---

All error responses share one shape: `{ "error": { "code", "message", "details?" } }` — codes are documented in [`ConnectErrorCode`](/connect/api/type-aliases/connecterrorcode/).

## Public endpoints

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness probe |
| `GET\|POST /api/auth/*` | Session auth (sign-in/up, dashboard cookies) |
| `GET /.well-known/openid-configuration` | OIDC discovery for Connect's issuer |
| `GET /.well-known/jwks.json` | JWKS (ES256 public keys) for workload JWT verification |
| `POST /v1/oidc/token` | Client credentials → 10-minute workload JWT (`{access_token, token_type, expires_in}`) |
| `GET /v1/oauth/callback` | OAuth provider redirect target (code exchange, installation upsert) |
| `POST /v1/webhooks/:connectorId/:ingestKey` | Webhook intake: verify, store, fan out to triggers |

## Authenticated `/v1` (session, PAT, or workload JWT)

Reads require `member` role, mutations `admin`, unless noted. Workload principals may **only** call `POST /v1/tokens`.

### Tokens

| Route | Purpose |
| --- | --- |
| `POST /v1/tokens` | Mint a short-lived provider token (body: connector, subject, scopes, resource, authorizationDetails) |

### Identity & org

| Route | Purpose |
| --- | --- |
| `GET /v1/me` | Current principal + active organization |
| `GET /v1/orgs` · `POST /v1/orgs` | List my orgs · create an org (session users only) |
| `GET /v1/members` | Org members |
| `GET /v1/usage` | Daily usage aggregation (`from`/`to` query) |
| `GET /v1/audit-logs` | Audit log (admin) |

### Connectors

| Route | Purpose |
| --- | --- |
| `GET /v1/connectors` · `POST /v1/connectors` | List · create |
| `GET /v1/connectors/:id` · `PATCH /v1/connectors/:id` · `DELETE /v1/connectors/:id` | Read · update (disable invalidates token cache) · delete |
| `PUT /v1/connectors/:id/secrets` | Rotate write-only secrets |
| `GET /v1/connectors/:id/installations` · `POST /v1/connectors/:id/installations` | List · register manually (GitHub Apps) |
| `POST /v1/connectors/:id/installations/:installationId/revoke` | Revoke an installation |
| `POST /v1/connectors/:id/authorize` | Start an OAuth authorization (returns consent URL + state) |
| `POST /v1/connectors/discover` | OIDC discovery for a custom issuer |

### Triggers & deliveries

| Route | Purpose |
| --- | --- |
| `GET /v1/connectors/:id/triggers` · `POST /v1/connectors/:id/triggers` | List · create (returns `whsec_` secret once) |
| `PATCH /v1/triggers/:id` · `DELETE /v1/triggers/:id` | Toggle/rename · delete |
| `GET /v1/triggers/:id/deliveries` | Delivery history with per-attempt status |
| `POST /v1/deliveries/:id/redeliver` | Reset and re-enqueue a delivery |

### Projects & links

| Route | Purpose |
| --- | --- |
| `GET /v1/projects` · `POST /v1/projects` · `GET /v1/projects/:id` | List · create · read |
| `POST /v1/projects/:id/clients` · `GET /v1/projects/:id/clients` · `DELETE /v1/projects/:id/clients/:clientId` | Workload identity clients (secret shown once) |
| `GET /v1/links` · `POST /v1/links` · `DELETE /v1/links/:id` | Project↔connector links per environment |

### Access tokens

| Route | Purpose |
| --- | --- |
| `GET /v1/access-tokens` · `POST /v1/access-tokens` · `DELETE /v1/access-tokens/:id` | List · create PAT (plaintext once) · revoke |
