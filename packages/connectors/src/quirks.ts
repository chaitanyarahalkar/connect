import type { OAuthConfig } from '@connect/shared';
import type { ProviderIdentity, ProviderQuirks, TokenSet } from './types.js';

/** Vanilla RFC 6749 token response. */
export function parseStandardTokenResponse(raw: Record<string, unknown>): TokenSet {
  if (raw.error) {
    throw new ProviderTokenError(String(raw.error), String(raw.error_description ?? ''));
  }
  if (typeof raw.access_token !== 'string') {
    throw new ProviderTokenError('invalid_response', 'token response missing access_token');
  }
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    expiresIn: typeof raw.expires_in === 'number' ? raw.expires_in : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    raw,
  };
}

export class ProviderTokenError extends Error {
  constructor(
    public code: string,
    description: string,
  ) {
    super(`${code}${description ? `: ${description}` : ''}`);
    this.name = 'ProviderTokenError';
  }
}

const standardQuirks: ProviderQuirks = {
  refreshRotates: false,
  parseTokenResponse: parseStandardTokenResponse,
  identify: async (tokenSet, cfg, fetchImpl): Promise<ProviderIdentity> => {
    if (!cfg.userinfoEndpoint) return { externalAccountId: 'default' };
    const res = await fetchImpl(cfg.userinfoEndpoint, {
      headers: { authorization: `Bearer ${tokenSet.accessToken}` },
    });
    if (!res.ok) return { externalAccountId: 'default' };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      externalAccountId: String(body.sub ?? body.id ?? 'default'),
      externalAccountName: typeof body.name === 'string' ? body.name : undefined,
    };
  },
};

const slackQuirks: ProviderQuirks = {
  // Slack rotates refresh tokens on every refresh when rotation is enabled.
  refreshRotates: true,
  authorizeExtraParams: (scopes) => ({
    // Slack splits bot scopes (`scope`) from user scopes (`user_scope`);
    // we pass everything as bot scopes by default.
    scope: scopes.join(','),
  }),
  parseTokenResponse: (raw): TokenSet => {
    // Slack returns HTTP 200 with ok:false on errors.
    if (raw.ok === false) {
      throw new ProviderTokenError(String(raw.error ?? 'slack_error'), '');
    }
    // User tokens nest under authed_user.
    const authedUser = raw.authed_user as Record<string, unknown> | undefined;
    const accessToken =
      typeof raw.access_token === 'string'
        ? raw.access_token
        : typeof authedUser?.access_token === 'string'
          ? authedUser.access_token
          : undefined;
    if (!accessToken) {
      throw new ProviderTokenError('invalid_response', 'slack response missing access_token');
    }
    const source = typeof raw.access_token === 'string' ? raw : authedUser!;
    return {
      accessToken,
      refreshToken:
        typeof source.refresh_token === 'string' ? source.refresh_token : undefined,
      expiresIn: typeof source.expires_in === 'number' ? source.expires_in : undefined,
      scope: typeof source.scope === 'string' ? source.scope : undefined,
      raw,
    };
  },
  identify: async (tokenSet): Promise<ProviderIdentity> => {
    const raw = tokenSet.raw;
    const team = raw.team as Record<string, unknown> | undefined;
    return {
      externalAccountId: String(team?.id ?? 'unknown-workspace'),
      externalAccountName: typeof team?.name === 'string' ? team.name : undefined,
    };
  },
};

const githubQuirks: ProviderQuirks = {
  // GitHub OAuth user tokens rotate when expiration is enabled; classic ones don't expire.
  refreshRotates: true,
  defaultExpirySeconds: 900, // policy TTL for non-expiring GitHub tokens
  parseTokenResponse: parseStandardTokenResponse,
  identify: async (tokenSet, _cfg, fetchImpl): Promise<ProviderIdentity> => {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: {
        authorization: `Bearer ${tokenSet.accessToken}`,
        'user-agent': 'connect',
        accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return { externalAccountId: 'unknown' };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      externalAccountId: String(body.id ?? 'unknown'),
      externalAccountName: typeof body.login === 'string' ? body.login : undefined,
    };
  },
};

const QUIRKS: Record<string, ProviderQuirks> = {
  standard: standardQuirks,
  slack: slackQuirks,
  github: githubQuirks,
  mock: standardQuirks,
};

export function quirksFor(key: string | undefined): ProviderQuirks {
  return (key && QUIRKS[key]) || standardQuirks;
}
