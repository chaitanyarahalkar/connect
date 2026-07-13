import { and, eq, isNull } from 'drizzle-orm';
import { installationGrants, installations, newId } from '@connect/db';
import { decryptSecret, encryptSecret, secretAad, type EncryptedBlob } from '@connect/crypto';
import { ConnectError, type OAuthConfig } from '@connect/shared';
import { ProviderTokenError, quirksFor, type TokenSet } from '@connect/connectors';
import { exchangeJwtBearer, refreshGrant, type OAuthClient } from '../oauth/engine.js';
import type { AppDeps } from '../deps.js';
import { readConnectorSecret, type ConnectorRow, type MintContext, type Minter } from './minters.js';
import type { CachedToken } from './cache.js';

const FALLBACK_EXPIRY_SECONDS = 3600;

/** Generic oauth2 (and preset github/slack) minter: refresh-token or jwt-bearer grants. */
export const mintOAuth2Token: Minter = async (ctx) => {
  const cfg = oauthConfigOf(ctx.connector);
  const client = await oauthClientOf(ctx.deps, ctx.connector);

  if (ctx.subject.type === 'jwt-bearer') {
    const tokenSet = await runProviderCall(ctx, () =>
      exchangeJwtBearer(
        cfg,
        client,
        { assertion: (ctx.subject as { assertion: string }).assertion, scopes: ctx.scopes },
        ctx.deps.providerFetch,
      ),
    );
    return toCachedToken(tokenSet, ctx.scopes);
  }

  if (!ctx.installation) {
    throw new ConnectError('installation_required', 'no installation resolved for oauth connector');
  }

  return refreshWithRotation(ctx, cfg, client);
};

/**
 * Refresh under a row lock so concurrent mints can't race a rotating refresh
 * token: the current grant row is SELECT … FOR UPDATE'd for the duration of
 * the provider call; rotation inserts the replacement and supersedes the old
 * row in the same transaction.
 */
async function refreshWithRotation(
  ctx: MintContext,
  cfg: OAuthConfig,
  client: OAuthClient,
): Promise<CachedToken> {
  const { deps, installation } = ctx;
  const installationId = installation!.id;
  const quirks = quirksFor(cfg.quirksKey);

  // Each concurrent waiter may find its locked row superseded after the
  // winner commits a rotation, so allow enough retries for a burst of
  // concurrent mints to fully serialize.
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await deps.db.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(installationGrants)
        .where(
          and(
            eq(installationGrants.installationId, installationId),
            eq(installationGrants.grantType, 'refresh_token'),
            isNull(installationGrants.supersededById),
          ),
        )
        .for('update');

      if (!grant) return null; // superseded while we waited — retry outer loop

      const refreshToken = decryptSecret(
        deps.keyProvider,
        secretAad('installation_grants', installationId, 'refresh_token'),
        grant.ciphertext as EncryptedBlob,
      );

      const tokenSet = await runProviderCall(ctx, () =>
        refreshGrant(cfg, client, { refreshToken, scopes: ctx.scopes }, deps.providerFetch),
      );

      if (tokenSet.refreshToken && (quirks.refreshRotates || tokenSet.refreshToken !== refreshToken)) {
        const id = newId.grant();
        await tx.insert(installationGrants).values({
          id,
          installationId,
          grantType: 'refresh_token',
          ciphertext: encryptSecret(
            deps.keyProvider,
            secretAad('installation_grants', installationId, 'refresh_token'),
            tokenSet.refreshToken,
          ),
          scopes: grant.scopes,
        });
        await tx
          .update(installationGrants)
          .set({ supersededById: id, rotatedAt: new Date() })
          .where(eq(installationGrants.id, grant.id));
      }
      return toCachedToken(tokenSet, ctx.scopes);
    });

    if (result) return result;

    // null means our locked row vanished. If no current refresh grant exists
    // at all, there's nothing to retry for — fall through to the fallback.
    const [current] = await deps.db
      .select({ id: installationGrants.id })
      .from(installationGrants)
      .where(
        and(
          eq(installationGrants.installationId, installationId),
          eq(installationGrants.grantType, 'refresh_token'),
          isNull(installationGrants.supersededById),
        ),
      )
      .limit(1);
    if (!current) break;
  }

  // No refresh grant: fall back to a stored access-token grant (providers
  // that don't issue refresh tokens).
  const [accessGrant] = await deps.db
    .select()
    .from(installationGrants)
    .where(
      and(
        eq(installationGrants.installationId, installationId),
        eq(installationGrants.grantType, 'access_token'),
        isNull(installationGrants.supersededById),
      ),
    )
    .limit(1);
  if (accessGrant && (!accessGrant.expiresAt || accessGrant.expiresAt > new Date())) {
    const token = decryptSecret(
      deps.keyProvider,
      secretAad('installation_grants', installationId, 'access_token'),
      accessGrant.ciphertext as EncryptedBlob,
    );
    return {
      token,
      tokenType: 'bearer',
      expiresAt: (
        accessGrant.expiresAt ?? new Date(Date.now() + deps.config.apiKeyTokenTtl * 1000)
      ).toISOString(),
      scopes: accessGrant.scopes,
    };
  }

  throw new ConnectError('grant_expired', 'no usable grant for this installation; re-authorize');
}

/** Wraps a provider call, mapping invalid_grant to a dead installation. */
async function runProviderCall(ctx: MintContext, call: () => Promise<TokenSet>): Promise<TokenSet> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ProviderTokenError) {
      if (err.code === 'invalid_grant' && ctx.installation) {
        await ctx.deps.db
          .update(installations)
          .set({ status: 'pending' })
          .where(eq(installations.id, ctx.installation.id));
        throw new ConnectError('grant_expired', 'provider rejected the stored grant; re-authorize', {
          providerError: err.code,
        });
      }
      throw new ConnectError('provider_error', `provider token request failed: ${err.message}`, {
        providerError: err.code,
      });
    }
    throw err;
  }
}

function toCachedToken(tokenSet: TokenSet, requestedScopes: string[]): CachedToken {
  const expiresIn = tokenSet.expiresIn ?? FALLBACK_EXPIRY_SECONDS;
  return {
    token: tokenSet.accessToken,
    tokenType: 'bearer',
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes: tokenSet.scope ? tokenSet.scope.split(/[ ,]+/).filter(Boolean) : requestedScopes,
  };
}

export function oauthConfigOf(connector: ConnectorRow): OAuthConfig {
  const cfg = connector.oauthConfig as OAuthConfig | null;
  if (!cfg) throw new ConnectError('validation_error', 'connector has no oauth configuration');
  return cfg;
}

export async function oauthClientOf(deps: AppDeps, connector: ConnectorRow): Promise<OAuthClient> {
  if (!connector.clientId) {
    throw new ConnectError('validation_error', 'connector has no oauth client id');
  }
  const clientSecret = await readConnectorSecret(
    deps.db,
    deps.keyProvider,
    connector.id,
    'oauth_client_secret',
  );
  if (!clientSecret) {
    throw new ConnectError('validation_error', 'connector has no oauth client secret stored');
  }
  return { clientId: connector.clientId, clientSecret };
}
