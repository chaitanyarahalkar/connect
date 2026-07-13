import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { newId, projectLinks } from '@connect/db';
import { ConnectError, environmentSchema } from '@connect/shared';
import type { AppDeps } from '../deps.js';
import { requireRole, type AuthEnv } from '../auth/middleware.js';
import { writeAudit } from '../audit.js';
import { findConnector } from './connectors.js';
import { findProject } from './projects.js';

export function linkRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const projectFilter = c.req.query('project');
    const connectorFilter = c.req.query('connector');
    let rows = await deps.db.select().from(projectLinks);
    if (projectFilter) {
      const project = await findProject(deps, principal.orgId, projectFilter);
      rows = rows.filter((r) => r.projectId === project.id);
    }
    if (connectorFilter) {
      const connector = await findConnector(deps, principal.orgId, connectorFilter);
      rows = rows.filter((r) => r.connectorId === connector.id);
    }
    // scope to org: join through projects
    const orgProjects = new Set(
      (await deps.db.query.projects.findMany({ where: (p, { eq: e }) => e(p.orgId, principal.orgId) })).map(
        (p) => p.id,
      ),
    );
    return c.json({ links: rows.filter((r) => orgProjects.has(r.projectId)) });
  });

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        project: z.string().min(1),
        connector: z.string().min(1),
        environments: z.array(environmentSchema).min(1),
        defaultInstallationId: z.string().optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const input = c.req.valid('json');
      const project = await findProject(deps, principal.orgId, input.project);
      const connector = await findConnector(deps, principal.orgId, input.connector);

      const [existing] = await deps.db
        .select()
        .from(projectLinks)
        .where(and(eq(projectLinks.projectId, project.id), eq(projectLinks.connectorId, connector.id)))
        .limit(1);

      const values = {
        environments: input.environments,
        defaultInstallationId: input.defaultInstallationId ?? null,
      };
      const row = existing
        ? (
            await deps.db
              .update(projectLinks)
              .set(values)
              .where(eq(projectLinks.id, existing.id))
              .returning()
          )[0]
        : (
            await deps.db
              .insert(projectLinks)
              .values({
                id: newId.link(),
                projectId: project.id,
                connectorId: connector.id,
                createdByUserId: principal.kind === 'user' ? principal.actorId : null,
                ...values,
              })
              .returning()
          )[0];

      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: existing ? 'link.update' : 'link.create',
        targetType: 'project_link',
        targetId: row!.id,
        metadata: { project: project.slug, connector: connector.slug, environments: input.environments },
      });
      return c.json({ link: row }, existing ? 200 : 201);
    },
  );

  app.delete('/:id', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const [row] = await deps.db.select().from(projectLinks).where(eq(projectLinks.id, c.req.param('id'))).limit(1);
    if (!row) throw new ConnectError('not_found', 'link not found');
    const project = await findProject(deps, principal.orgId, row.projectId); // org check
    await deps.db.delete(projectLinks).where(eq(projectLinks.id, row.id));
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'link.delete',
      targetType: 'project_link',
      targetId: row.id,
      metadata: { project: project.slug },
    });
    return c.json({ ok: true });
  });

  return app;
}
