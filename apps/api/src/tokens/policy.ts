import { ConnectError, type TokenPolicy, type TokenRequest } from '@connect/shared';
import type { Redis } from 'ioredis';
import type { CachedToken } from './cache.js';
import type { ConnectorRow } from './minters.js';

export function tokenPolicyOf(connector: ConnectorRow): TokenPolicy {
  return (connector.tokenPolicy ?? {}) as TokenPolicy;
}

/** Subject and scope allow-lists. Runs before any cache lookup or mint. */
export function enforceTokenPolicy(policy: TokenPolicy, req: TokenRequest, scopes: string[]): void {
  if (policy.allowedSubjects && !policy.allowedSubjects.includes(req.subject.type)) {
    throw new ConnectError(
      'subject_not_allowed',
      `connector policy does not allow the ${req.subject.type} subject`,
      { allowedSubjects: policy.allowedSubjects },
    );
  }
  if (policy.allowedScopes) {
    const allowed = new Set(policy.allowedScopes);
    const denied = scopes.filter((s) => !allowed.has(s));
    if (denied.length > 0) {
      throw new ConnectError('scope_not_allowed', 'connector policy does not allow these scopes', {
        denied,
        allowedScopes: policy.allowedScopes,
      });
    }
  }
}

/**
 * Fixed-window rate limit on token requests, scoped to the installation
 * (falling back to a connector-wide bucket when no installation is involved).
 * Counts every request, cache hits included — the limit is on requests, not
 * provider mints, so a hot cache cannot be used to spin.
 */
export async function enforceRateLimit(
  redis: Redis,
  policy: TokenPolicy,
  connectorId: string,
  installationId: string | null,
): Promise<void> {
  const rl = policy.rateLimit;
  if (!rl) return;
  const key = `rl:tok:${connectorId}:${installationId ?? '-'}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pexpire(key, rl.windowSeconds * 1000);
  }
  if (count > rl.limit) {
    let retryAfterMs = await redis.pttl(key);
    if (retryAfterMs < 0) {
      // window key lost its TTL (e.g. crash between INCR and PEXPIRE) — reset
      await redis.pexpire(key, rl.windowSeconds * 1000);
      retryAfterMs = rl.windowSeconds * 1000;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    throw new ConnectError(
      'rate_limited',
      `rate limit exceeded: ${rl.limit} token requests per ${rl.windowSeconds}s for this installation`,
      { limit: rl.limit, windowSeconds: rl.windowSeconds, retryAfterSeconds },
    );
  }
}

/** Clamps a minted token's advertised lifetime to the policy cap. */
export function clampTtl(token: CachedToken, policy: TokenPolicy): CachedToken {
  if (!policy.maxTtlSeconds) return token;
  const cap = Date.now() + policy.maxTtlSeconds * 1000;
  if (new Date(token.expiresAt).getTime() <= cap) return token;
  return { ...token, expiresAt: new Date(cap).toISOString() };
}
