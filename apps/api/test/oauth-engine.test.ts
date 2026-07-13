import { describe, expect, it } from 'vitest';
import type { OAuthConfig } from '@connect/shared';
import { ProviderTokenError } from '@connect/connectors';
import { buildAuthorizationUrl, exchangeCode, refreshGrant } from '../src/oauth/engine.js';
import { codeChallengeS256, generateCodeVerifier } from '../src/oauth/pkce.js';

const cfg = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  authorizationEndpoint: 'https://provider.test/authorize',
  tokenEndpoint: 'https://provider.test/token',
  scopesDefault: [],
  pkce: true,
  tokenEndpointAuth: 'post',
  ...over,
});

const client = { clientId: 'cid', clientSecret: 'csec' };

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const res = handler(String(url), (init ?? {}) as RequestInit);
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe('buildAuthorizationUrl', () => {
  it('includes PKCE challenge and scopes', () => {
    const verifier = generateCodeVerifier();
    const url = new URL(
      buildAuthorizationUrl(cfg(), {
        clientId: 'cid',
        redirectUri: 'https://app.test/cb',
        state: 'st',
        scopes: ['read', 'write'],
        codeChallenge: codeChallengeS256(verifier),
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('applies slack quirks: comma-joined scope param', () => {
    const url = new URL(
      buildAuthorizationUrl(cfg({ quirksKey: 'slack', pkce: false }), {
        clientId: 'cid',
        redirectUri: 'https://app.test/cb',
        state: 'st',
        scopes: ['chat:write', 'channels:read'],
      }),
    );
    expect(url.searchParams.get('scope')).toBe('chat:write,channels:read');
    expect(url.searchParams.get('code_challenge')).toBeNull();
  });
});

describe('token endpoint auth styles', () => {
  it('post: sends credentials in the body', async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { access_token: 'at', expires_in: 100 },
    }));
    await exchangeCode(cfg(), client, { code: 'c', redirectUri: 'https://app.test/cb' }, impl);
    const body = String(calls[0]!.init.body);
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=csec');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('basic: sends credentials in the Authorization header', async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { access_token: 'at', expires_in: 100 },
    }));
    await exchangeCode(
      cfg({ tokenEndpointAuth: 'basic' }),
      client,
      { code: 'c', redirectUri: 'https://app.test/cb' },
      impl,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(String(calls[0]!.init.body)).not.toContain('client_secret');
  });
});

describe('provider quirks in responses', () => {
  it('rejects slack ok:false responses despite HTTP 200', async () => {
    const { impl } = fakeFetch(() => ({ body: { ok: false, error: 'invalid_code' } }));
    await expect(
      exchangeCode(cfg({ quirksKey: 'slack' }), client, { code: 'x', redirectUri: 'r' }, impl),
    ).rejects.toThrowError(ProviderTokenError);
  });

  it('unwraps slack authed_user tokens', async () => {
    const { impl } = fakeFetch(() => ({
      body: {
        ok: true,
        team: { id: 'T1', name: 'Acme' },
        authed_user: { access_token: 'xoxp-user', expires_in: 3600, scope: 'chat:write' },
      },
    }));
    const set = await exchangeCode(cfg({ quirksKey: 'slack' }), client, { code: 'x', redirectUri: 'r' }, impl);
    expect(set.accessToken).toBe('xoxp-user');
    expect(set.expiresIn).toBe(3600);
  });

  it('applies the github default expiry when expires_in is missing', async () => {
    const { impl } = fakeFetch(() => ({ body: { access_token: 'gho_abc', scope: 'repo' } }));
    const set = await refreshGrant(cfg({ quirksKey: 'github' }), client, { refreshToken: 'rt' }, impl);
    expect(set.expiresIn).toBe(900);
  });

  it('maps oauth error responses to ProviderTokenError', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    await expect(refreshGrant(cfg(), client, { refreshToken: 'dead' }, impl)).rejects.toThrowError(
      /invalid_grant/,
    );
  });

  it('synthesizes an error for non-json failure statuses', async () => {
    const { impl } = fakeFetch(() => ({ status: 502, body: {} }));
    await expect(refreshGrant(cfg(), client, { refreshToken: 'rt' }, impl)).rejects.toThrowError(
      /http_502/,
    );
  });
});
