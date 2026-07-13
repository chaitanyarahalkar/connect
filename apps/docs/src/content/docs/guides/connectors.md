---
title: Setting up connectors
description: api_key, generic OAuth2 (PKCE), GitHub, and Slack connectors — config shapes, presets, and provider quirks.
sidebar:
  order: 3
---

A **connector** is an org-owned record for one provider. Four types are supported: `api_key`, generic `oauth2`, and the `github`/`slack` presets (which ride the generic OAuth engine with provider-specific quirks). Create connectors in the dashboard wizard, via `connect connectors create`, or with `POST /v1/connectors`.

## Configuration shape

```jsonc
{
  "slug": "slack-main",          // 2–64 chars, ^[a-z0-9][a-z0-9-]*[a-z0-9]$
  "name": "Slack (main)",
  "type": "slack",               // oauth2 | api_key | github | slack
  "oauthConfig": {
    "authorizationEndpoint": "https://slack.com/oauth/v2/authorize",
    "tokenEndpoint": "https://slack.com/api/oauth.v2.access",
    "revocationEndpoint": "https://slack.com/api/auth.revoke",   // optional
    "userinfoEndpoint": "…",     // optional, used to label installations
    "issuer": "…",               // optional, enables OIDC discovery
    "scopesDefault": ["chat:write"],
    "pkce": false,               // default true
    "tokenEndpointAuth": "post", // 'basic' | 'post' (default 'post')
    "quirksKey": "slack"
  },
  "branding": { "iconUrl": "…", "color": "#611f69" },
  "secrets": {                   // write-only — never readable back
    "oauthClientId": "…",
    "oauthClientSecret": "…",
    "apiKey": "…",
    "webhookSecret": "…",
    "githubAppId": "…",
    "githubAppPrivateKey": "…",
    "slackSigningSecret": "…"
  }
}
```

OAuth-based types require `oauthConfig`. All secrets are envelope-encrypted at rest and can only be rotated (`PUT /v1/connectors/:id/secrets`), never read.

For custom OAuth2 providers that support OIDC discovery, `POST /v1/connectors/discover` (or the wizard's "Discover from issuer URL") fills the endpoints from `/.well-known/openid-configuration`.

## api_key connectors

The simplest type: store a provider API key once; `getToken` returns it as a short-lived credential for `app` subjects only. Token lifetime is the policy TTL (`API_KEY_TOKEN_TTL`, default 900s) — the underlying key never leaves Connect with a longer validity than that window.

## Generic oauth2 connectors

Full authorization-code flow with PKCE (S256) by default. Refresh tokens are stored envelope-encrypted; refreshes run under a row lock with single-flight de-duplication so rotating refresh tokens can't be lost to a race. Superseded grants are retained for forensics.

## GitHub preset

Prefills from `packages/connectors/src/presets.ts`:

- Authorize: `https://github.com/login/oauth/authorize`, token: `https://github.com/login/oauth/access_token`
- Default scopes `repo`, `read:user`; `tokenEndpointAuth: 'post'`; PKCE off (GitHub OAuth apps)
- Quirks: refresh tokens rotate; non-expiring tokens get a 900s policy TTL; installations are labeled via `https://api.github.com/user`

**GitHub App mode:** if you set `githubAppId` and `githubAppPrivateKey` in secrets, `app`-subject token requests mint **installation access tokens**: Connect signs a short-lived RS256 app JWT and calls `POST /app/installations/{id}/access_tokens`, narrowing by `repositories`/`permissions` passed via `authorizationDetails`. User-subject requests still use the OAuth flow.

## Slack preset

- Authorize: `https://slack.com/oauth/v2/authorize`, token: `https://slack.com/api/oauth.v2.access`, revocation: `https://slack.com/api/auth.revoke`
- Default scope `chat:write`; `tokenEndpointAuth: 'post'`; PKCE off
- Quirks: scopes are passed comma-joined; Slack's HTTP-200-`ok:false` errors are handled; user tokens nested under `authed_user` are parsed; refresh rotation is on; installations are labeled by workspace (`team.id`/`team.name`)
- Set `slackSigningSecret` to enable inbound webhook verification (see [Triggers & webhooks](/connect/guides/triggers/))

## Google preset

- Authorize: `https://accounts.google.com/o/oauth2/v2/auth`, token: `https://oauth2.googleapis.com/token`, revocation + userinfo endpoints prefilled
- Default scopes `openid`, `email`, `profile`; PKCE on
- Quirks: `access_type=offline&prompt=consent` are always sent (without them Google only issues a refresh token on first consent); refresh tokens do not rotate; installations are labeled via the OIDC userinfo endpoint (email)

## Salesforce preset

- Authorize/token/revocation on `https://login.salesforce.com/services/oauth2/*`; PKCE on
- Default scopes `api`, `refresh_token`
- Quirks: Salesforce omits `expires_in`, so a 7200s policy TTL applies; installations are labeled from the token response's identity URL (org id + username). For sandboxes, switch the endpoints to `https://test.salesforce.com`.

## Snowflake preset (key-pair JWT exchange)

A `snowflake` connector holds an RSA private key and mints **KEYPAIR_JWTs locally** — no provider round-trip. Configure `providerConfig` (`account`, `username`, optional `tokenTtlSeconds` ≤ 3600) and store the PKCS#8 private key as `snowflakePrivateKey`; the matching public key must be registered on the Snowflake user (`ALTER USER … SET RSA_PUBLIC_KEY`).

`getToken` returns a short-lived RS256 JWT with the fingerprinted issuer Snowflake expects (`ACCOUNT.USER.SHA256:<fp>`). Send it as:

```
Authorization: Bearer <token>
X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT
```

Only the `app` subject is supported; tokens are cached until expiry.

## Token policy

Every connector can carry a `tokenPolicy` (set in the dashboard's Settings tab or via `PATCH /v1/connectors/:id`), enforced on every `POST /v1/tokens`:

```jsonc
{
  "maxTtlSeconds": 600,               // clamp the advertised token lifetime
  "allowedScopes": ["chat:write"],    // requests outside the list → scope_not_allowed (403)
  "allowedSubjects": ["app"],         // → subject_not_allowed (403)
  "rateLimit": { "limit": 100, "windowSeconds": 60 }
}
```

The rate limit is a fixed window **scoped per installation** (requests without an installation share one connector-wide bucket) and counts cache hits — it limits token *requests*, not provider mints. Exceeding it returns `429 rate_limited` with a `Retry-After` header, which the SDK honors automatically. TTL clamping happens before the token is cached, so cached entries expire with the policy. Policy changes invalidate the connector's token cache.

## Installations

One connector serves many tenants. An **installation** is one tenant's grant — created by the OAuth callback (matched on subject user or external account id), or registered manually for GitHub Apps. Token requests resolve an installation automatically: an explicit `installationId` wins; `user` subjects use that user's active installation; otherwise a single active installation is used, and multiple candidates raise `installation_ambiguous`.

## Linking to projects

Workloads can only mint tokens for connectors **linked to their project and environment** (`production`/`preview`/`development`):

```bash
connect link demo-app slack-main --env production,preview
```

Dashboard users and PATs skip link enforcement; workload identities do not.
