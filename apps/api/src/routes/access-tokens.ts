import { generateSecret } from '@connect/crypto';
import { accessTokens, newId } from '@connect/db';
import { ConnectError } from '@connect/shared';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { type AuthEnv, requireRole } from '../auth/middleware.js';
import type { AppDeps } from '../deps.js';

export function accessTokenRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const rows = await deps.db
      .select({
        id: accessTokens.id,
        name: accessTokens.name,
        tokenPrefix: accessTokens.tokenPrefix,
        scopes: accessTokens.scopes,
        expiresAt: accessTokens.expiresAt,
        lastUsedAt: accessTokens.lastUsedAt,
        revokedAt: accessTokens.revokedAt,
        createdAt: accessTokens.createdAt,
      })
      .from(accessTokens)
      .where(eq(accessTokens.orgId, principal.orgId))
      .orderBy(desc(accessTokens.createdAt));
    return c.json({ tokens: rows });
  });

  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120),
        expiresInDays: z.number().int().positive().max(365).optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const input = c.req.valid('json');
      const secret = generateSecret('cn_pat_');
      const id = newId.accessToken();
      await deps.db.insert(accessTokens).values({
        id,
        orgId: principal.orgId,
        userId: principal.kind === 'user' ? principal.actorId : null,
        name: input.name,
        tokenHash: secret.hash,
        tokenPrefix: secret.prefix,
        expiresAt: input.expiresInDays
          ? new Date(Date.now() + input.expiresInDays * 86_400_000)
          : null,
      });
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'access_token.create',
        targetType: 'access_token',
        targetId: id,
        metadata: { name: input.name },
      });
      // plaintext returned exactly once
      return c.json({ token: { id, name: input.name, plaintext: secret.plaintext } }, 201);
    },
  );

  app.delete('/:id', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const [row] = await deps.db
      .update(accessTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(accessTokens.id, c.req.param('id')), eq(accessTokens.orgId, principal.orgId)))
      .returning();
    if (!row) throw new ConnectError('not_found', 'access token not found');
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'access_token.revoke',
      targetType: 'access_token',
      targetId: row.id,
    });
    return c.json({ ok: true });
  });

  return app;
}
