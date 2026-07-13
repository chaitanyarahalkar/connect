import { SignJWT, importPKCS8 } from 'jose';
import { ConnectError } from '@connect/shared';
import type { Minter } from './minters.js';
import { readConnectorSecret } from './minters.js';
import { mintOAuth2Token } from './oauth2-minter.js';
import type { CachedToken } from './cache.js';

const GITHUB_API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

/**
 * GitHub connectors run in two modes:
 * - App mode (githubAppId + private key stored): app JWT → installation
 *   access token, optionally narrowed by repositories/permissions from
 *   authorizationDetails. Used for `app` subjects.
 * - OAuth mode: user-subject tokens ride the generic oauth2 engine.
 */
export const mintGithubToken: Minter = async (ctx) => {
  const cfg = (ctx.connector.oauthConfig ?? {}) as Record<string, unknown>;
  const appId = typeof cfg.githubAppId === 'string' ? cfg.githubAppId : undefined;

  if (ctx.subject.type !== 'app' || !appId) {
    return mintOAuth2Token(ctx);
  }

  if (!ctx.installation?.externalAccountId) {
    throw new ConnectError(
      'installation_required',
      'github app connectors need an installation with the GitHub installation id',
    );
  }

  const privateKeyPem = await readConnectorSecret(
    ctx.deps.db,
    ctx.deps.keyProvider,
    ctx.connector.id,
    'github_app_private_key',
  );
  if (!privateKeyPem) {
    throw new ConnectError('validation_error', 'connector has no GitHub App private key stored');
  }

  const appJwt = await signAppJwt(appId, privateKeyPem);

  const body: Record<string, unknown> = {};
  for (const detail of ctx.authorizationDetails ?? []) {
    if (Array.isArray(detail.repositories)) body.repositories = detail.repositories;
    if (detail.permissions && typeof detail.permissions === 'object') {
      body.permissions = detail.permissions;
    }
  }

  const res = await ctx.deps.providerFetch(
    `${GITHUB_API}/app/installations/${ctx.installation.externalAccountId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'connect',
      },
      body: JSON.stringify(body),
    },
  );
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof raw.token !== 'string') {
    throw new ConnectError('provider_error', `github installation token request failed (${res.status})`, {
      providerMessage: raw.message,
    });
  }

  const token: CachedToken = {
    token: raw.token,
    tokenType: 'bearer',
    expiresAt:
      typeof raw.expires_at === 'string'
        ? new Date(raw.expires_at).toISOString()
        : new Date(Date.now() + 3600_000).toISOString(),
    scopes: ctx.scopes,
  };
  return token;
};

async function signAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(now - 60) // clock-drift allowance per GitHub docs
    .setExpirationTime(now + 540)
    .sign(key);
}
