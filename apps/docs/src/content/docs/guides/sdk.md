---
title: Using the SDK
description: Request short-lived provider tokens with @connect/sdk — caching, retries, timeouts, and typed errors.
sidebar:
  order: 1
---

`@connect/sdk` requests short-lived provider tokens with in-process refresh-ahead caching, single-flight de-duplication, retries with `Retry-After` support, per-attempt timeouts, and a fully typed error hierarchy. Zero runtime dependencies.

```ts
import { Connect } from '@connect/sdk';

const connect = new Connect();
const { token } = await connect.getToken({ connector: 'github', scopes: ['repo'] });
```

The module-level [`getToken()`](/connect/api/functions/gettoken/) delegates to a shared default instance and remains fully supported:

```ts
import { getToken } from '@connect/sdk';

const { token } = await getToken({ connector: 'github', scopes: ['repo'] });
```

## Authentication

Your workload authenticates with **its own identity**, never a provider secret. Credentials resolve in this order:

| Source | Meaning |
| --- | --- |
| `auth` option | Explicit credential — overrides everything |
| `CONNECT_OIDC_TOKEN` | Platform-issued OIDC workload JWT |
| `CONNECT_CLIENT_ID` / `CONNECT_CLIENT_SECRET` | Client credentials — the SDK self-mints a workload JWT (cached, single-flighted) |
| `CONNECT_ACCESS_TOKEN` | Personal access token (`cn_pat_…`) |

`CONNECT_API_URL` sets the API base URL when no `baseUrl` is configured.

## Configuration

Every field of [`ConnectConfig`](/connect/api/interfaces/connectconfig/) is optional:

```ts
const connect = new Connect({
  baseUrl: 'https://connect.example.com', // default: CONNECT_API_URL or http://localhost:4000
  auth: 'cn_pat_…',                       // default: env resolution (see above)
  timeoutMs: 10_000,                      // per-attempt timeout
  retry: {
    attempts: 3,                          // total attempts, incl. the first; 1 disables retries
    baseDelayMs: 1000,                    // exponential backoff base
    maxDelayMs: 4000,                     // backoff ceiling (before jitter)
    retryAfterCapMs: 30_000,              // longest Retry-After honored
  },
  cacheSize: 100,                         // LRU-evicted token cache entries
  validityBufferMs: 30_000,               // treat tokens as stale this early
  refreshAheadFraction: 0.8,              // background-refresh after 80% of observed lifetime
  onRequest: (e) => log.debug(e),         // { url, method, attempt }
  onRetry: (e) => log.warn(e),            // { url, method, attempt, delayMs, status?, error? }
});
```

## Requesting tokens

```ts
// act as your app
const app = await connect.getToken({ connector: 'slack-main', scopes: ['chat:write'] });

// act as a specific user who authorized earlier
const user = await connect.getToken({
  connector: 'github',
  subject: { type: 'user', userId: 'user_123' },
});

// abort a call (retries included) — background refreshes are unaffected
const controller = new AbortController();
const t = await connect.getToken({ connector: 'github' }, { signal: controller.signal });
```

See [`GetTokenParams`](/connect/api/interfaces/gettokenparams/) for all fields, including `installationId`, `resource`, and `authorizationDetails`.

Tokens are cached in-process per (base URL, connector, installation, subject, scopes, resource) and refreshed in the background once 80% of their observed lifetime has elapsed, so hot paths never block on a mint. Concurrent calls for the same token share one request. Tokens are *also* cached server-side (encrypted, in Redis) so a fleet of instances shares mints.

## Errors

All errors extend [`ConnectError`](/connect/api/classes/connecterror/) with machine-readable `code`, HTTP `status`, and optional `details`:

| Class | When |
| --- | --- |
| [`ConnectAuthError`](/connect/api/classes/connectautherror/) | `unauthorized` / `forbidden` — bad or missing Connect credentials |
| [`LinkNotFoundError`](/connect/api/classes/linknotfounderror/) | Connector not linked to the calling project |
| [`EnvironmentNotEnabledError`](/connect/api/classes/environmentnotenablederror/) | Project link doesn't enable this environment |
| [`InstallationRequiredError`](/connect/api/classes/installationrequirederror/) | Installation required, ambiguous, or revoked |
| [`UserAuthorizationRequiredError`](/connect/api/classes/userauthorizationrequirederror/) | Subject user hasn't authorized the connector |
| [`GrantExpiredError`](/connect/api/classes/grantexpirederror/) | Provider grant expired — re-authorize |
| [`ProviderError`](/connect/api/classes/providererror/) | Upstream provider rejected the request |
| `ConnectError` (`code: 'timeout'`) | An attempt exceeded `timeoutMs` |
| `ConnectError` (`code: 'network_error'`) | All attempts failed to reach the server |
| `ConnectError` (`code: 'validation_error'`) | Malformed params rejected client-side |

```ts
import { getToken, UserAuthorizationRequiredError } from '@connect/sdk';

try {
  await getToken({ connector: 'github', subject: { type: 'user', userId: 'user_123' } });
} catch (err) {
  if (err instanceof UserAuthorizationRequiredError) {
    // send the user through the connector's authorize flow
  }
}
```

## Retry semantics

- **Network errors and timeouts** are retried with jittered exponential backoff (token mints are safe to replay).
- **429** is always retried; a `Retry-After` header (seconds or HTTP-date) is honored exactly, up to `retryAfterCapMs`.
- **5xx** is retried for idempotent requests, and for 503 responses carrying `Retry-After`.
- Aborting the caller's `signal` fails immediately — no retry.

## Control-plane client

[`ConnectClient`](/connect/api/classes/connectclient/) is a thin authenticated REST wrapper over the control plane (used by the Connect CLI), sharing the same retry/timeout machinery:

```ts
import { ConnectClient } from '@connect/sdk';

const client = new ConnectClient({ baseUrl, auth: 'cn_pat_…', timeoutMs: 5000 });
const me = await client.get('/v1/me');
```
