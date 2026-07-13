---
title: Security model
description: Envelope encryption, hashed bearer secrets, workload identity, and rotation-safe refresh.
sidebar:
  order: 5
---

## Envelope encryption at rest

Every stored secret (API keys, OAuth client secrets, refresh tokens, signing keys) gets its own AES-256-GCM data key, wrapped by a master key (`CONNECT_MASTER_KEY`, with a KMS-ready `KeyProvider` interface). **AAD binds each ciphertext to its row** (`table:rowId:kind`), so ciphertexts cannot be swapped between records. Key versions enable rotation.

## No plaintext bearer secrets in the database

Personal access tokens and workload client secrets are stored as SHA-256 hashes and shown exactly once at creation. Lookups match on the hash; a database leak yields no usable credentials.

## Workload identity

Deployments never hold provider secrets — they exchange client credentials for a **10-minute ES256 JWT** from Connect's own issuer (JWKS published at `/.well-known/jwks.json`, discovery at `/.well-known/openid-configuration`). The JWT carries the project and environment (`sub: project:{id}:env:{environment}`), and token requests are authorized against project links *and* that baked-in environment.

Workload principals are deliberately powerless beyond minting: they can call `POST /v1/tokens` and nothing else — the control plane (connectors, secrets, triggers, members) requires a user session or PAT with sufficient role (`member` for reads, `admin` for mutations).

## Rotation-safe refresh

Provider refreshes run under a Postgres row lock (`SELECT … FOR UPDATE`) with Redis single-flight de-duplication, so a rotating refresh token (Slack-style) can't be lost to a race between concurrent instances. When a provider rotates, the new grant is inserted and the old one superseded **in the same transaction**; superseded grants are retained for forensics.

## Webhooks

- **Inbound**: per-connector random ingest path + provider HMAC verification (GitHub `X-Hub-Signature-256`, Slack `v0` with a 5-minute replay window, generic HMAC). Invalid signatures are stored flagged but never forwarded.
- **Outbound**: every delivery is signed with a per-trigger `whsec_` secret (`connect-signature` header).

Details in [Triggers & webhooks](/connect/guides/triggers/).

## Metering & audit

Every token issuance and webhook delivery is metered (`usage_events`) and recorded (`token_issuances`, `audit_logs`) **without ever storing token material**. The audit log is visible to admins in the dashboard's Settings → Audit Log tab or via `GET /v1/audit-logs`.

## Token caching

Server-side token caches live in Redis, envelope-encrypted with the cache key as AAD. Entries carry a 60s clock-skew allowance and are never written with less than 5s of remaining validity. `jwt-bearer` subject tokens are never cached.
