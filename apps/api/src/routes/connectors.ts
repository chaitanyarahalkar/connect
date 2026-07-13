import { randomToken } from '@connect/crypto';
import { connectors, installations, newId } from '@connect/db';
import {
  brandingSchema,
  ConnectError,
  createConnectorSchema,
  oauthConfigSchema,
  snowflakeConfigSchema,
  tokenPolicySchema,
} from '@connect/shared';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { type AuthEnv, requireRole } from '../auth/middleware.js';
import { isUniqueViolation } from '../db-errors.js';
import type { AppDeps } from '../deps.js';
import { storeConnectorSecret } from '../secrets.js';
import { TokenCache } from '../tokens/cache.js';

const SECRET_KIND_MAP = {
  oauthClientSecret: 'oauth_client_secret',
  apiKey: 'api_key',
  webhookSecret: 'webhook_secret',
  githubAppPrivateKey: 'github_app_private_key',
  slackSigningSecret: 'slack_signing_secret',
  snowflakePrivateKey: 'snowflake_private_key',
} as const;

function serialize(row: typeof connectors.$inferSelect) {
  // never expose ingest key material beyond what the dashboard needs
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    status: row.status,
    branding: row.branding,
    oauthConfig: row.oauthConfig,
    providerConfig: row.providerConfig,
    tokenPolicy: row.tokenPolicy,
    clientId: row.clientId,
    ingestKey: row.ingestKey,
    createdAt: row.createdAt.toISOString(),
  };
}

export function connectorRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const rows = await deps.db
      .select()
      .from(connectors)
      .where(eq(connectors.orgId, principal.orgId))
      .orderBy(desc(connectors.createdAt));
    return c.json({ connectors: rows.map(serialize) });
  });

  app.post('/', zValidator('json', createConnectorSchema), async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const input = c.req.valid('json');

    if (
      (input.type === 'oauth2' || input.type === 'github' || input.type === 'slack') &&
      !input.oauthConfig
    ) {
      throw new ConnectError('validation_error', `${input.type} connectors require oauthConfig`);
    }
    if (input.type === 'snowflake') {
      const parsed = snowflakeConfigSchema.safeParse(input.providerConfig ?? {});
      if (!parsed.success) {
        throw new ConnectError(
          'validation_error',
          'snowflake connectors require providerConfig with account and username',
        );
      }
      input.providerConfig = parsed.data;
    }

    const id = newId.connector();
    const [row] = await deps.db
      .insert(connectors)
      .values({
        id,
        orgId: principal.orgId,
        slug: input.slug,
        name: input.name,
        type: input.type,
        branding: input.branding ?? null,
        oauthConfig: input.oauthConfig ?? null,
        providerConfig: input.providerConfig ?? null,
        tokenPolicy: input.tokenPolicy ?? null,
        clientId: input.secrets?.oauthClientId ?? null,
        ingestKey: randomToken(24),
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err, 'connectors_org_slug_uq')) {
          throw new ConnectError('conflict', `connector slug "${input.slug}" already exists`);
        }
        throw err;
      });

    for (const [field, kind] of Object.entries(SECRET_KIND_MAP)) {
      const value = input.secrets?.[field as keyof typeof SECRET_KIND_MAP];
      if (value) await storeConnectorSecret(deps.db, deps.keyProvider, id, kind, value);
    }
    if (input.secrets?.githubAppId) {
      await deps.db
        .update(connectors)
        .set({
          oauthConfig: { ...(input.oauthConfig ?? {}), githubAppId: input.secrets.githubAppId },
        })
        .where(eq(connectors.id, id));
    }

    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'connector.create',
      targetType: 'connector',
      targetId: id,
      metadata: { slug: input.slug, type: input.type },
    });
    return c.json({ connector: serialize(row!) }, 201);
  });

  app.get('/:id', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const row = await findConnector(deps, principal.orgId, c.req.param('id'));
    return c.json({ connector: serialize(row) });
  });

  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120).optional(),
        status: z.enum(['active', 'disabled']).optional(),
        branding: brandingSchema.optional(),
        oauthConfig: oauthConfigSchema.optional(),
        providerConfig: z.record(z.unknown()).optional(),
        tokenPolicy: tokenPolicySchema.nullable().optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const row = await findConnector(deps, principal.orgId, c.req.param('id'));
      const input = c.req.valid('json');
      const [updated] = await deps.db
        .update(connectors)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.branding ? { branding: input.branding } : {}),
          ...(input.oauthConfig ? { oauthConfig: input.oauthConfig } : {}),
          ...(input.providerConfig
            ? {
                providerConfig:
                  row.type === 'snowflake'
                    ? snowflakeConfigSchema.parse(input.providerConfig)
                    : input.providerConfig,
              }
            : {}),
          ...(input.tokenPolicy !== undefined ? { tokenPolicy: input.tokenPolicy } : {}),
        })
        .where(eq(connectors.id, row.id))
        .returning();
      // policy/config changes must not be served stale from the token cache
      if (input.status === 'disabled' || input.tokenPolicy !== undefined || input.providerConfig) {
        await new TokenCache(deps.redis, deps.keyProvider).invalidateConnector(row.id);
      }
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'connector.update',
        targetType: 'connector',
        targetId: row.id,
        metadata: input as Record<string, unknown>,
      });
      return c.json({ connector: serialize(updated!) });
    },
  );

  app.put(
    '/:id/secrets',
    zValidator(
      'json',
      z.object({
        oauthClientId: z.string().optional(),
        oauthClientSecret: z.string().optional(),
        apiKey: z.string().optional(),
        webhookSecret: z.string().optional(),
        githubAppPrivateKey: z.string().optional(),
        slackSigningSecret: z.string().optional(),
        snowflakePrivateKey: z.string().optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const row = await findConnector(deps, principal.orgId, c.req.param('id'));
      const input = c.req.valid('json');
      if (input.oauthClientId) {
        await deps.db
          .update(connectors)
          .set({ clientId: input.oauthClientId })
          .where(eq(connectors.id, row.id));
      }
      for (const [field, kind] of Object.entries(SECRET_KIND_MAP)) {
        const value = input[field as keyof typeof SECRET_KIND_MAP];
        if (value) await storeConnectorSecret(deps.db, deps.keyProvider, row.id, kind, value);
      }
      await new TokenCache(deps.redis, deps.keyProvider).invalidateConnector(row.id);
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'connector.secrets.rotate',
        targetType: 'connector',
        targetId: row.id,
        metadata: { kinds: Object.keys(input) },
      });
      return c.json({ ok: true });
    },
  );

  app.delete('/:id', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const row = await findConnector(deps, principal.orgId, c.req.param('id'));
    await deps.db.delete(connectors).where(eq(connectors.id, row.id));
    await new TokenCache(deps.redis, deps.keyProvider).invalidateConnector(row.id);
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'connector.delete',
      targetType: 'connector',
      targetId: row.id,
    });
    return c.json({ ok: true });
  });

  app.get('/:id/installations', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const row = await findConnector(deps, principal.orgId, c.req.param('id'));
    const rows = await deps.db
      .select()
      .from(installations)
      .where(eq(installations.connectorId, row.id))
      .orderBy(desc(installations.createdAt));
    return c.json({
      installations: rows.map((i) => ({
        id: i.id,
        status: i.status,
        externalAccountId: i.externalAccountId,
        externalAccountName: i.externalAccountName,
        subjectUserId: i.subjectUserId,
        createdAt: i.createdAt.toISOString(),
        revokedAt: i.revokedAt?.toISOString() ?? null,
      })),
    });
  });

  /** Manual registration, e.g. a GitHub App installation id from the provider's UI. */
  app.post(
    '/:id/installations',
    zValidator(
      'json',
      z.object({
        externalAccountId: z.string().min(1),
        externalAccountName: z.string().optional(),
        subjectUserId: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const row = await findConnector(deps, principal.orgId, c.req.param('id'));
      const input = c.req.valid('json');
      const id = newId.installation();
      await deps.db.insert(installations).values({
        id,
        connectorId: row.id,
        status: 'active',
        externalAccountId: input.externalAccountId,
        externalAccountName: input.externalAccountName,
        subjectUserId: input.subjectUserId,
        installedByUserId: principal.kind === 'user' ? principal.actorId : null,
        metadata: input.metadata,
      });
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'installation.register',
        targetType: 'installation',
        targetId: id,
        metadata: { externalAccountId: input.externalAccountId },
      });
      return c.json({ installation: { id, status: 'active' } }, 201);
    },
  );

  app.post('/:id/installations/:installationId/revoke', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const row = await findConnector(deps, principal.orgId, c.req.param('id'));
    const [inst] = await deps.db
      .update(installations)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(installations.id, c.req.param('installationId')),
          eq(installations.connectorId, row.id),
        ),
      )
      .returning();
    if (!inst) throw new ConnectError('not_found', 'installation not found');
    await new TokenCache(deps.redis, deps.keyProvider).invalidateConnector(row.id);
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'installation.revoke',
      targetType: 'installation',
      targetId: inst.id,
    });
    return c.json({ ok: true });
  });

  return app;
}

export async function findConnector(deps: AppDeps, orgId: string, idOrSlug: string) {
  const [row] = await deps.db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        or(eq(connectors.id, idOrSlug), eq(connectors.slug, idOrSlug)),
      ),
    )
    .limit(1);
  if (!row) throw new ConnectError('not_found', `connector "${idOrSlug}" not found`);
  return row;
}
