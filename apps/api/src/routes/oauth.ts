import { quirksFor } from '@connect/connectors';
import { installations, newId } from '@connect/db';
import { ConnectError } from '@connect/shared';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { type AuthEnv, requireRole } from '../auth/middleware.js';
import type { AppDeps } from '../deps.js';
import { logger } from '../logger.js';
import { buildAuthorizationUrl, discover, exchangeCode } from '../oauth/engine.js';
import { storeGrant } from '../oauth/grants.js';
import { codeChallengeS256, generateCodeVerifier } from '../oauth/pkce.js';
import { consumeState, createState } from '../oauth/state.js';
import { oauthClientOf, oauthConfigOf } from '../tokens/oauth2-minter.js';
import { findConnector } from './connectors.js';

function redirectUriFor(deps: AppDeps): string {
  return `${deps.config.issuer}/v1/oauth/callback`;
}

/** Authenticated: start an authorization flow / discover endpoints. */
export function oauthAuthorizeRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.post(
    '/:id/authorize',
    zValidator(
      'json',
      z
        .object({
          scopes: z.array(z.string()).optional(),
          subjectUserId: z.string().optional(),
          redirectTo: z.string().url().optional(),
        })
        .default({}),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'member');
      const connector = await findConnector(deps, principal.orgId, c.req.param('id'));
      const cfg = oauthConfigOf(connector);
      if (!connector.clientId) {
        throw new ConnectError('validation_error', 'connector has no oauth client id configured');
      }

      const codeVerifier = cfg.pkce ? generateCodeVerifier() : undefined;
      const input = c.req.valid('json');
      const state = await createState(deps.redis, {
        connectorId: connector.id,
        orgId: principal.orgId,
        codeVerifier,
        redirectTo: input.redirectTo,
        subjectUserId: input.subjectUserId,
        initiatedByUserId: principal.kind === 'user' ? principal.actorId : undefined,
      });

      const url = buildAuthorizationUrl(cfg, {
        clientId: connector.clientId,
        redirectUri: redirectUriFor(deps),
        state,
        scopes: input.scopes ?? cfg.scopesDefault ?? [],
        codeChallenge: codeVerifier ? codeChallengeS256(codeVerifier) : undefined,
      });
      return c.json({ url, state });
    },
  );

  app.post('/discover', zValidator('json', z.object({ issuer: z.string().url() })), async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const partial = await discover(c.req.valid('json').issuer, deps.providerFetch);
    return c.json({ config: partial });
  });

  return app;
}

/** Public: the provider redirects the browser here after consent. */
export function oauthCallbackRoutes(deps: AppDeps) {
  const app = new Hono();

  app.get('/v1/oauth/callback', async (c) => {
    const { code, state, error } = c.req.query();
    if (error) {
      return c.redirect(
        `${deps.config.dashboardUrl}/connectors?error=${encodeURIComponent(error)}`,
      );
    }
    if (!code || !state) {
      throw new ConnectError('validation_error', 'missing code or state');
    }
    const stored = await consumeState(deps.redis, state);
    if (!stored) {
      throw new ConnectError('unauthorized', 'unknown or expired oauth state');
    }

    const [connector] = await deps.db.query.connectors.findMany({
      where: (t, { eq: e }) => e(t.id, stored.connectorId),
      limit: 1,
    });
    if (!connector) throw new ConnectError('not_found', 'connector no longer exists');
    const cfg = oauthConfigOf(connector);
    const client = await oauthClientOf(deps, connector);

    const tokenSet = await exchangeCode(
      cfg,
      client,
      { code, redirectUri: redirectUriFor(deps), codeVerifier: stored.codeVerifier },
      deps.providerFetch,
    );

    const quirks = quirksFor(cfg.quirksKey);
    const identity = await quirks
      .identify?.(tokenSet, cfg, deps.providerFetch)
      .catch(() => ({ externalAccountId: 'unknown' as string, externalAccountName: undefined }));

    const installationId = await upsertInstallation(deps, {
      connectorId: connector.id,
      externalAccountId: identity?.externalAccountId ?? 'unknown',
      externalAccountName: identity?.externalAccountName,
      subjectUserId: stored.subjectUserId,
      installedByUserId: stored.initiatedByUserId,
    });

    if (tokenSet.refreshToken) {
      await storeGrant(
        deps.db,
        deps.keyProvider,
        installationId,
        'refresh_token',
        tokenSet.refreshToken,
        {
          scopes: tokenSet.scope?.split(/[ ,]+/).filter(Boolean) ?? [],
        },
      );
    } else {
      await storeGrant(
        deps.db,
        deps.keyProvider,
        installationId,
        'access_token',
        tokenSet.accessToken,
        {
          scopes: tokenSet.scope?.split(/[ ,]+/).filter(Boolean) ?? [],
          expiresAt: tokenSet.expiresIn ? new Date(Date.now() + tokenSet.expiresIn * 1000) : null,
        },
      );
    }

    await writeAudit(deps.db, null, {
      orgId: stored.orgId,
      action: 'installation.authorized',
      targetType: 'installation',
      targetId: installationId,
      metadata: {
        connector: connector.slug,
        externalAccountId: identity?.externalAccountId,
        subjectUserId: stored.subjectUserId,
      },
    });
    logger.info({ connector: connector.slug, installationId }, 'oauth callback completed');

    const dest =
      stored.redirectTo ??
      `${deps.config.dashboardUrl}/connectors/${connector.id}?installed=${installationId}`;
    return c.redirect(dest);
  });

  return app;
}

async function upsertInstallation(
  deps: AppDeps,
  params: {
    connectorId: string;
    externalAccountId: string;
    externalAccountName?: string;
    subjectUserId?: string;
    installedByUserId?: string;
  },
): Promise<string> {
  const match = params.subjectUserId
    ? and(
        eq(installations.connectorId, params.connectorId),
        eq(installations.subjectUserId, params.subjectUserId),
      )
    : and(
        eq(installations.connectorId, params.connectorId),
        eq(installations.externalAccountId, params.externalAccountId),
        isNull(installations.subjectUserId),
      );

  const [existing] = await deps.db.select().from(installations).where(match).limit(1);
  if (existing) {
    await deps.db
      .update(installations)
      .set({
        status: 'active',
        revokedAt: null,
        externalAccountId: params.externalAccountId,
        externalAccountName: params.externalAccountName ?? existing.externalAccountName,
      })
      .where(eq(installations.id, existing.id));
    return existing.id;
  }

  const id = newId.installation();
  await deps.db.insert(installations).values({
    id,
    connectorId: params.connectorId,
    status: 'active',
    externalAccountId: params.externalAccountId,
    externalAccountName: params.externalAccountName,
    subjectUserId: params.subjectUserId,
    installedByUserId: params.installedByUserId,
  });
  return id;
}
