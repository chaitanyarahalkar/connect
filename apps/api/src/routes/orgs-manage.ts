import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { memberships, newId, organizations } from '@connect/db';
import { ConnectError, slugSchema } from '@connect/shared';
import type { AppDeps } from '../deps.js';
import type { AuthEnv } from '../auth/middleware.js';
import { writeAudit } from '../audit.js';
import { isUniqueViolation } from '../db-errors.js';

/** Org bootstrap: list my orgs / create one. Session users only. */
export function orgManageRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const principal = c.get('principal');
    if (principal.kind === 'workload') throw new ConnectError('forbidden', 'workloads cannot list orgs');
    if (principal.kind === 'access_token') {
      const [org] = await deps.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, principal.orgId))
        .limit(1);
      return c.json({ organizations: org ? [{ ...org, role: principal.role }] : [] });
    }
    const rows = await deps.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(eq(memberships.userId, principal.actorId));
    return c.json({ organizations: rows });
  });

  app.post(
    '/',
    zValidator('json', z.object({ name: z.string().min(1).max(120), slug: slugSchema })),
    async (c) => {
      const principal = c.get('principal');
      if (principal.kind !== 'user') {
        throw new ConnectError('forbidden', 'only dashboard users can create organizations');
      }
      const input = c.req.valid('json');
      const orgId = newId.org();
      try {
        await deps.db.transaction(async (tx) => {
          await tx.insert(organizations).values({ id: orgId, name: input.name, slug: input.slug });
          await tx.insert(memberships).values({
            id: newId.membership(),
            orgId,
            userId: principal.actorId,
            role: 'owner',
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConnectError('conflict', `organization slug "${input.slug}" is taken`);
        }
        throw err;
      }
      await writeAudit(deps.db, principal, {
        orgId,
        action: 'org.create',
        targetType: 'organization',
        targetId: orgId,
        metadata: { slug: input.slug },
      });
      return c.json({ organization: { id: orgId, name: input.name, slug: input.slug, role: 'owner' } }, 201);
    },
  );

  return app;
}
