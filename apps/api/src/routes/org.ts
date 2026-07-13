import { Hono } from 'hono';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { auditLogs, memberships, organizations, usageEvents, user } from '@connect/db';
import { ConnectError } from '@connect/shared';
import type { AppDeps } from '../deps.js';
import { requireRole, type AuthEnv } from '../auth/middleware.js';

export function orgRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/me', async (c) => {
    const principal = c.get('principal');
    const [org] = await deps.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, principal.orgId))
      .limit(1);
    if (!org) throw new ConnectError('not_found', 'organization not found');
    return c.json({
      principal: {
        kind: principal.kind,
        actorId: principal.actorId,
        role: principal.kind === 'workload' ? null : principal.role,
      },
      organization: { id: org.id, name: org.name, slug: org.slug },
    });
  });

  app.get('/members', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const rows = await deps.db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        name: user.name,
        email: user.email,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.orgId, principal.orgId));
    return c.json({ members: rows });
  });

  app.get('/usage', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const from = c.req.query('from')
      ? new Date(c.req.query('from')!)
      : new Date(Date.now() - 30 * 86_400_000);
    const to = c.req.query('to') ? new Date(c.req.query('to')!) : new Date();

    const day = sql<string>`date_trunc('day', ${usageEvents.occurredAt})::date::text`;
    const daily = await deps.db
      .select({
        day,
        kind: usageEvents.kind,
        connectorId: usageEvents.connectorId,
        total: sql<number>`sum(${usageEvents.quantity})::int`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.orgId, principal.orgId),
          gte(usageEvents.occurredAt, from),
          lte(usageEvents.occurredAt, to),
        ),
      )
      .groupBy(day, usageEvents.kind, usageEvents.connectorId)
      .orderBy(day);

    return c.json({ from: from.toISOString(), to: to.toISOString(), daily });
  });

  app.get('/audit-logs', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const rows = await deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.orgId, principal.orgId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return c.json({ logs: rows });
  });

  return app;
}
