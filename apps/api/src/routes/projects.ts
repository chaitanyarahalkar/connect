import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { newId, projectClients, projects } from '@connect/db';
import { generateSecret } from '@connect/crypto';
import { ConnectError, environmentSchema, slugSchema } from '@connect/shared';
import type { AppDeps } from '../deps.js';
import { isUniqueViolation } from '../db-errors.js';
import { requireRole, type AuthEnv } from '../auth/middleware.js';
import { writeAudit } from '../audit.js';

export function projectRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const rows = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.orgId, principal.orgId))
      .orderBy(desc(projects.createdAt));
    return c.json({ projects: rows });
  });

  app.post(
    '/',
    zValidator('json', z.object({ name: z.string().min(1).max(120), slug: slugSchema })),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const input = c.req.valid('json');
      const [row] = await deps.db
        .insert(projects)
        .values({ id: newId.project(), orgId: principal.orgId, name: input.name, slug: input.slug })
        .returning()
        .catch((err: unknown) => {
          if (isUniqueViolation(err, 'projects_org_slug_uq')) {
            throw new ConnectError('conflict', `project slug "${input.slug}" already exists`);
          }
          throw err;
        });
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'project.create',
        targetType: 'project',
        targetId: row!.id,
        metadata: { slug: input.slug },
      });
      return c.json({ project: row }, 201);
    },
  );

  app.get('/:id', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const row = await findProject(deps, principal.orgId, c.req.param('id'));
    return c.json({ project: row });
  });

  /** Create a workload-identity client. The secret is returned exactly once. */
  app.post(
    '/:id/clients',
    zValidator('json', z.object({ environment: environmentSchema })),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const project = await findProject(deps, principal.orgId, c.req.param('id'));
      const { environment } = c.req.valid('json');
      const clientId = `pc_${newId.projectClient().slice(4)}`;
      const secret = generateSecret('pcs_');
      await deps.db.insert(projectClients).values({
        id: newId.projectClient(),
        projectId: project.id,
        clientId,
        clientSecretHash: secret.hash,
        environment,
      });
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'project.client.create',
        targetType: 'project',
        targetId: project.id,
        metadata: { clientId, environment },
      });
      return c.json(
        { client: { clientId, clientSecret: secret.plaintext, environment, projectId: project.id } },
        201,
      );
    },
  );

  app.get('/:id/clients', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const project = await findProject(deps, principal.orgId, c.req.param('id'));
    const rows = await deps.db
      .select({
        clientId: projectClients.clientId,
        environment: projectClients.environment,
        createdAt: projectClients.createdAt,
      })
      .from(projectClients)
      .where(and(eq(projectClients.projectId, project.id), isNull(projectClients.revokedAt)));
    return c.json({ clients: rows });
  });

  app.delete('/:id/clients/:clientId', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const project = await findProject(deps, principal.orgId, c.req.param('id'));
    const [row] = await deps.db
      .update(projectClients)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(projectClients.projectId, project.id),
          eq(projectClients.clientId, c.req.param('clientId')),
        ),
      )
      .returning();
    if (!row) throw new ConnectError('not_found', 'client not found');
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'project.client.revoke',
      targetType: 'project',
      targetId: project.id,
      metadata: { clientId: row.clientId },
    });
    return c.json({ ok: true });
  });

  return app;
}

export async function findProject(deps: AppDeps, orgId: string, idOrSlug: string) {
  const [row] = await deps.db
    .select()
    .from(projects)
    .where(
      and(eq(projects.orgId, orgId), or(eq(projects.id, idOrSlug), eq(projects.slug, idOrSlug))),
    )
    .limit(1);
  if (!row) throw new ConnectError('not_found', `project "${idOrSlug}" not found`);
  return row;
}
