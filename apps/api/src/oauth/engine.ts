import type { OAuthConfig } from '@connect/shared';
import {
  parseStandardTokenResponse,
  quirksFor,
  type ProviderQuirks,
  type TokenSet,
} from '@connect/connectors';

/**
 * Generic OAuth 2.0 / OIDC engine. Pure functions, fetch injected — provider
 * differences come in through ProviderQuirks, not separate flow code.
 */

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function buildAuthorizationUrl(
  cfg: OAuthConfig,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    scopes: string[];
    codeChallenge?: string;
  },
): string {
  const quirks = quirksFor(cfg.quirksKey);
  const url = new URL(cfg.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  if (params.scopes.length && !quirks.authorizeExtraParams) {
    url.searchParams.set('scope', params.scopes.join(' '));
  }
  if (cfg.pkce && params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(quirks.authorizeExtraParams?.(params.scopes) ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function exchangeCode(
  cfg: OAuthConfig,
  client: OAuthClient,
  params: { code: string; redirectUri: string; codeVerifier?: string },
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  };
  if (cfg.pkce && params.codeVerifier) body.code_verifier = params.codeVerifier;
  return tokenEndpointRequest(cfg, client, body, fetchImpl);
}

export async function refreshGrant(
  cfg: OAuthConfig,
  client: OAuthClient,
  params: { refreshToken: string; scopes?: string[] },
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  };
  if (params.scopes?.length) body.scope = params.scopes.join(' ');
  return tokenEndpointRequest(cfg, client, body, fetchImpl);
}

/** RFC 7523 JWT bearer exchange. */
export async function exchangeJwtBearer(
  cfg: OAuthConfig,
  client: OAuthClient,
  params: { assertion: string; scopes?: string[] },
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: params.assertion,
  };
  if (params.scopes?.length) body.scope = params.scopes.join(' ');
  return tokenEndpointRequest(cfg, client, body, fetchImpl);
}

export async function revokeToken(
  cfg: OAuthConfig,
  client: OAuthClient,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (!cfg.revocationEndpoint) return false;
  const res = await fetchImpl(cfg.revocationEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth(client),
    },
    body: new URLSearchParams({ token }),
  });
  return res.ok;
}

/** OIDC discovery: fills endpoints from /.well-known/openid-configuration. */
export async function discover(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<Partial<OAuthConfig>> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`discovery failed with status ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  return {
    issuer: typeof doc.issuer === 'string' ? doc.issuer : issuer,
    authorizationEndpoint: doc.authorization_endpoint as string | undefined,
    tokenEndpoint: doc.token_endpoint as string | undefined,
    revocationEndpoint: doc.revocation_endpoint as string | undefined,
    userinfoEndpoint: doc.userinfo_endpoint as string | undefined,
  };
}

async function tokenEndpointRequest(
  cfg: OAuthConfig,
  client: OAuthClient,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const quirks: ProviderQuirks = quirksFor(cfg.quirksKey);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const params = new URLSearchParams(body);
  if (cfg.tokenEndpointAuth === 'basic') {
    headers.authorization = basicAuth(client);
  } else {
    params.set('client_id', client.clientId);
    params.set('client_secret', client.clientSecret);
  }

  const res = await fetchImpl(cfg.tokenEndpoint, { method: 'POST', headers, body: params });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && !raw.error) {
    raw.error = `http_${res.status}`;
  }
  const parse = quirks.parseTokenResponse ?? parseStandardTokenResponse;
  const tokenSet = parse(raw);
  if (tokenSet.expiresIn === undefined && quirks.defaultExpirySeconds) {
    tokenSet.expiresIn = quirks.defaultExpirySeconds;
  }
  return tokenSet;
}

function basicAuth(client: OAuthClient): string {
  return `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
}
