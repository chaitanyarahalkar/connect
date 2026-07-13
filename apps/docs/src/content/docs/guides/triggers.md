---
title: Triggers & webhooks
description: Verified inbound webhooks fanned out to your services with a connect-signature.
sidebar:
  order: 4
---

**Triggers** turn provider webhooks into verified, signed deliveries to your own endpoints. Inbound, Connect verifies each provider's HMAC scheme; outbound, every delivery is signed with a per-trigger secret so your services only need to trust Connect.

## Inbound: webhook ingest

Each connector gets a random ingest path:

```
POST /v1/webhooks/{connectorId}/{ingestKey}
```

The ingest key is compared timing-safe, then the raw body is verified per connector type:

| Connector type | Scheme | Header(s) | Secret |
| --- | --- | --- | --- |
| `github` | `sha256=` + HMAC-SHA256(secret, raw body) | `x-hub-signature-256` | `webhookSecret` |
| `slack` | `v0=` + HMAC-SHA256 over `v0:{timestamp}:{body}`, **±5 min replay window** | `x-slack-request-timestamp`, `x-slack-signature` | `slackSigningSecret` |
| generic (`oauth2`/`api_key`) | `sha256=` + HMAC-SHA256(secret, raw body) | `x-webhook-signature` (or `x-connect-signature`) | `webhookSecret` |

Behavior worth knowing:

- **Invalid signatures are stored but never forwarded** — the event lands in `webhook_events` flagged `signatureValid=false` (headers redacted) and the request gets a 401. You keep forensics without risking delivery of forged events.
- **De-duplication** is keyed on the provider's delivery id (`x-github-delivery`, Slack request timestamp, or `x-webhook-id`); replays return `{ deduplicated: true }`.
- Slack `url_verification` challenges are answered automatically.

## Triggers: fan-out destinations

A trigger subscribes a destination URL to a connector's events, optionally filtered by exact event type:

```
POST /v1/connectors/:id/triggers   → returns the whsec_ signing secret ONCE
```

Manage triggers from the dashboard (connector → Triggers tab) or the API: toggle active, delete, list deliveries, and redeliver.

## Outbound: signed delivery

Each matching event enqueues one delivery per trigger (BullMQ). Your endpoint receives:

| Header | Value |
| --- | --- |
| `connect-signature` | `sha256={HMAC-SHA256(whsec_secret, body)}` |
| `connect-event-id` | Connect's event id |
| `connect-event-type` | Provider event type |
| `connect-connector` | Connector slug |
| `user-agent` | `connect-webhooks` |

Verify by recomputing the HMAC over the **raw request body** with your `whsec_` secret and comparing timing-safe.

## Retries

Non-2xx responses are retried up to **5 attempts with exponential backoff (base 10s)**. Delivery status progresses `pending → delivering → succeeded | failed | dead`; final failures are marked `dead` and can be redelivered manually (`POST /v1/deliveries/:id/redeliver`), which resets the attempt counter and re-enqueues.

Every delivery is metered (`webhook_delivery` usage events) and visible in the dashboard's Deliveries dialog with per-attempt status.
