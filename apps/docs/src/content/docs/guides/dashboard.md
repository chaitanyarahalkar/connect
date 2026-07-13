---
title: Dashboard walkthrough
description: Tour of the Connect dashboard — overview, connector wizard, installations, links, triggers, playground, and settings.
sidebar:
  order: 7
---

The dashboard (`http://localhost:3000` locally) is the control plane UI. Sign up, create an organization during onboarding, and you land on the overview.

## Overview

Stat cards for token requests, webhook deliveries, active connectors, and projects, plus a daily token-request chart for the current month — all backed by `GET /v1/usage`.

## Connectors

The connectors list links to each connector's detail page and the **three-step wizard**:

1. **Type** — api_key, custom OAuth2, or the GitHub/Slack presets (endpoints and scopes prefilled).
2. **Configure** — name, slug, brand color; OAuth endpoints with *Discover from issuer URL* (OIDC discovery), default scopes, token-endpoint auth method, PKCE toggle; and the write-only credential fields for the chosen type.
3. **Review & create.**

Each connector detail page has five tabs plus an enable/disable toggle (disabling invalidates its server-side token cache):

| Tab | What you do there |
| --- | --- |
| **Overview** | Copy the OAuth callback URL and webhook ingest URL; view config |
| **Installations** | Start OAuth authorization ("Connect account"), register GitHub App installations, revoke |
| **Links** | Toggle project links per environment |
| **Triggers** | Create destinations (the `whsec_` secret is shown once), toggle, delete, inspect deliveries, redeliver |
| **Settings** | Rename, rotate write-only secrets, delete |

## Projects

Create projects and manage each project's linked connectors. The **Workload Identity** section creates per-environment clients — each shows a one-time `.env` snippet (`CONNECT_API_URL`, `CONNECT_CLIENT_ID`, `CONNECT_CLIENT_SECRET`) for your deployment.

## Playground

Mint a token interactively as the signed-in user: pick connector, installation, subject (`app` or `user`), and scopes; see the token with a live expiry countdown and a cached/fresh badge; copy a ready-made SDK snippet.

## Settings

Organization-level administration in three tabs:

- **Access Tokens** — create/revoke PATs (`cn_pat_…`, plaintext shown once).
- **Members** — org membership and roles.
- **Audit Log** — admin-only view of `audit_logs`.
