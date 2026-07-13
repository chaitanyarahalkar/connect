import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { accessTokens, memberships, type Db } from '@connect/db';
import { hashSecret } from '@connect/crypto';
import { ConnectError, type Role } from '@connect/shared';
import { hasRole, type Principal } from './principal.js';
import type { IssuerService } from './issuer.js';

export type SessionResolver = (c: Context) => Promise<Principal | null>;

export interface AuthEnv {
  Variables: {
    principal: Principal;
  };
}

/**
 * Resolves the caller, in order: better-auth session cookie (dashboard) →
 * PAT (`cn_pat_…`) → workload OIDC JWT. Sets `principal` or 401s.
 */
export function authMiddleware(
  db: Db,
  issuer: IssuerService,
  sessionResolver?: SessionResolver,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');

    if (!header) {
      if (sessionResolver) {
        const principal = await sessionResolver(c);
        if (principal) {
          c.set('principal', principal);
          return next();
        }
      }
      throw new ConnectError('unauthorized', 'missing credentials');
    }

    const token = header.replace(/^Bearer\s+/i, '');

    if (token.startsWith('cn_pat_')) {
      c.set('principal', await resolvePat(db, token));
      return next();
    }

    // Anything else in the Bearer slot must be a Connect workload JWT.
    try {
      const claims = await issuer.verifyWorkloadToken(token);
      c.set('principal', {
        kind: 'workload',
        actorId: `project:${claims.projectId}`,
        orgId: claims.orgId,
        projectId: claims.projectId,
        environment: claims.environment,
      });
    } catch {
      throw new ConnectError('unauthorized', 'invalid credentials');
    }
    return next();
  };
}

async function resolvePat(db: Db, token: string): Promise<Principal> {
  const hash = hashSecret(token);
  const [row] = await db
    .select()
    .from(accessTokens)
    .where(and(eq(accessTokens.tokenHash, hash), isNull(accessTokens.revokedAt)))
    .limit(1);
  if (!row) throw new ConnectError('unauthorized', 'invalid access token');
  if (row.expiresAt && row.expiresAt < new Date()) {
    throw new ConnectError('unauthorized', 'access token expired');
  }

  let role: Role = 'admin'; // org tokens without a creator act as admin
  if (row.userId) {
    const [membership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, row.orgId), eq(memberships.userId, row.userId)))
      .limit(1);
    if (!membership) throw new ConnectError('unauthorized', 'token owner is no longer a member');
    role = membership.role;
  }

  // fire-and-forget last_used_at
  void db
    .update(accessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(accessTokens.id, row.id))
    .catch(() => {});

  return { kind: 'access_token', actorId: row.id, orgId: row.orgId, role };
}

/** Throws unless the principal is a user/PAT with at least `min` role. */
export function requireRole(principal: Principal, min: Role): void {
  if (principal.kind === 'workload') {
    throw new ConnectError('forbidden', 'workload identities may only request tokens');
  }
  if (!hasRole(principal, min)) {
    throw new ConnectError('forbidden', `requires ${min} role`);
  }
}
