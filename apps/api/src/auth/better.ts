import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, eq, or } from 'drizzle-orm';
import { memberships, organizations, account, session, user, verification } from '@connect/db';
import type { Context } from 'hono';
import type { AppDeps } from '../deps.js';
import type { Principal } from './principal.js';
import type { SessionResolver } from './middleware.js';

const isProd = process.env.NODE_ENV === 'production';

export type BetterAuth = ReturnType<typeof createAuth>;

export function createAuth(deps: AppDeps) {
  return betterAuth({
    secret: deps.config.betterAuthSecret,
    baseURL: deps.config.issuer,
    basePath: '/api/auth',
    trustedOrigins: [deps.config.dashboardUrl],
    emailAndPassword: { enabled: true },
    advanced: {
      defaultCookieAttributes: {
        sameSite: isProd ? 'none' : 'lax',
        secure: isProd,
      },
    },
    database: drizzleAdapter(deps.db, {
      provider: 'pg',
      schema: { user, session, account, verification },
    }),
  });
}

/**
 * Dashboard sessions: resolve the better-auth cookie to a user, then the
 * active org from the x-connect-org header (id or slug) or the user's first
 * membership. Users with no org yet get an org-less principal that can only
 * hit the org-bootstrap routes.
 */
export function sessionResolverFor(deps: AppDeps, auth: BetterAuth): SessionResolver {
  return async (c: Context): Promise<Principal | null> => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    if (!session?.user) return null;
    const userId = session.user.id;

    const orgHint = c.req.header('x-connect-org');
    if (orgHint) {
      const [row] = await deps.db
        .select({ orgId: memberships.orgId, role: memberships.role })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(
          and(
            eq(memberships.userId, userId),
            or(eq(organizations.id, orgHint), eq(organizations.slug, orgHint)),
          ),
        )
        .limit(1);
      if (!row) return null; // hinted org exists but caller is not a member
      return { kind: 'user', actorId: userId, orgId: row.orgId, role: row.role };
    }

    const [first] = await deps.db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    if (first) {
      return { kind: 'user', actorId: userId, orgId: first.orgId, role: first.role };
    }
    // freshly signed-up user: no org yet
    return { kind: 'user', actorId: userId, orgId: '', role: 'member' };
  };
}
