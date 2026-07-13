import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';

/**
 * A tiny OAuth 2.0 provider used by tests and the demo. Implements the
 * authorization-code + PKCE flow, refresh (with optional rotation), revocation,
 * userinfo, and a webhook sender — everything needed to exercise Connect
 * end-to-end without registering real GitHub/Slack apps.
 */

export interface MockProviderOptions {
  clientId?: string;
  clientSecret?: string;
  /** Access-token lifetime in seconds. Keep short in tests to exercise refresh. */
  tokenTtlSeconds?: number;
  /** Rotate refresh tokens on every refresh (like Slack). */
  rotateRefreshTokens?: boolean;
  /** Issue refresh tokens at all. */
  issueRefreshTokens?: boolean;
}

interface CodeRecord {
  redirectUri: string;
  codeChallenge?: string;
  scope: string;
  sub: string;
}

interface TokenRecord {
  sub: string;
  scope: string;
  expiresAt: number;
}

export interface MockProviderState {
  codes: Map<string, CodeRecord>;
  accessTokens: Map<string, TokenRecord>;
  refreshTokens: Map<string, { sub: string; scope: string }>;
  /** Counters tests assert on. */
  stats: { authorizations: number; exchanges: number; refreshes: number; revocations: number };
}

export function buildMockProvider(opts: MockProviderOptions = {}) {
  const clientId = opts.clientId ?? 'mock-client-id';
  const clientSecret = opts.clientSecret ?? 'mock-client-secret';
  const ttl = opts.tokenTtlSeconds ?? 3600;
  const rotate = opts.rotateRefreshTokens ?? true;
  const issueRefresh = opts.issueRefreshTokens ?? true;

  const state: MockProviderState = {
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    stats: { authorizations: 0, exchanges: 0, refreshes: 0, revocations: 0 },
  };

  const app = new Hono();

  app.get('/oauth/authorize', (c) => {
    const q = c.req.query();
    if (q.client_id !== clientId) return c.text('unknown client', 400);
    if (!q.redirect_uri || !q.state) return c.text('missing redirect_uri/state', 400);

    const issue = () => {
      state.stats.authorizations++;
      const code = `code_${randomBytes(16).toString('hex')}`;
      state.codes.set(code, {
        redirectUri: q.redirect_uri!,
        codeChallenge: q.code_challenge,
        scope: q.scope ?? '',
        sub: q.as_user ?? 'mock-user-1',
      });
      const url = new URL(q.redirect_uri!);
      url.searchParams.set('code', code);
      url.searchParams.set('state', q.state!);
      return url.toString();
    };

    // auto=1 skips the consent screen (used by tests/demo)
    if (q.auto === '1') return c.redirect(issue());
    return c.html(
      `<html><body><h1>Mock Provider</h1>
       <p>App <b>${clientId}</b> wants access (scope: ${q.scope ?? 'none'}).</p>
       <a href="${issue()}">Approve</a></body></html>`,
    );
  });

  app.post('/oauth/token', async (c) => {
    const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
    if (body.client_id !== clientId || body.client_secret !== clientSecret) {
      return c.json({ error: 'invalid_client' }, 401);
    }

    if (body.grant_type === 'authorization_code') {
      const record = body.code ? state.codes.get(body.code) : undefined;
      if (!record) return c.json({ error: 'invalid_grant' }, 400);
      state.codes.delete(body.code!);
      if (record.redirectUri !== body.redirect_uri) return c.json({ error: 'invalid_grant' }, 400);
      if (record.codeChallenge) {
        const expected = createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url');
        if (expected !== record.codeChallenge) {
          return c.json(
            { error: 'invalid_grant', error_description: 'pkce verification failed' },
            400,
          );
        }
      }
      state.stats.exchanges++;
      return c.json(issueTokens(record.sub, record.scope));
    }

    if (body.grant_type === 'refresh_token') {
      const record = body.refresh_token ? state.refreshTokens.get(body.refresh_token) : undefined;
      if (!record) return c.json({ error: 'invalid_grant' }, 400);
      state.stats.refreshes++;
      if (rotate) state.refreshTokens.delete(body.refresh_token!);
      return c.json(issueTokens(record.sub, record.scope, rotate ? undefined : body.refresh_token));
    }

    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      if (!body.assertion) return c.json({ error: 'invalid_grant' }, 400);
      // trust the (unverified) assertion sub claim — it's a mock
      let sub = 'jwt-user';
      try {
        const payload = JSON.parse(
          Buffer.from(body.assertion.split('.')[1] ?? '', 'base64url').toString(),
        );
        if (typeof payload.sub === 'string') sub = payload.sub;
      } catch {
        /* keep default */
      }
      state.stats.exchanges++;
      const tokens = issueTokens(sub, body.scope ?? '');
      delete (tokens as Record<string, unknown>).refresh_token;
      return c.json(tokens);
    }

    return c.json({ error: 'unsupported_grant_type' }, 400);
  });

  app.post('/oauth/revoke', async (c) => {
    const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
    state.stats.revocations++;
    if (body.token) {
      state.accessTokens.delete(body.token);
      state.refreshTokens.delete(body.token);
    }
    return c.json({ ok: true });
  });

  app.get('/oauth/userinfo', (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const record = token ? state.accessTokens.get(token) : undefined;
    if (!record) return c.json({ error: 'invalid_token' }, 401);
    if (record.expiresAt < Date.now()) return c.json({ error: 'token_expired' }, 401);
    return c.json({ sub: record.sub, name: `Mock ${record.sub}` });
  });

  /** A protected resource: proves a minted token actually works. */
  app.get('/api/data', (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const record = token ? state.accessTokens.get(token) : undefined;
    if (!record || record.expiresAt < Date.now()) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ data: `hello ${record.sub}`, scope: record.scope });
  });

  /** Sends an HMAC-signed webhook (generic connect-style signature). */
  app.post('/send-webhook', async (c) => {
    const { url, secret, event } = (await c.req.json()) as {
      url: string;
      secret: string;
      event: Record<string, unknown>;
    };
    const payload = JSON.stringify({ type: 'mock.event', ...event });
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': signature,
        'x-mock-event': String(event.type ?? 'mock.event'),
        'x-mock-delivery': randomBytes(8).toString('hex'),
      },
      body: payload,
    });
    return c.json({ delivered: res.ok, status: res.status });
  });

  function issueTokens(sub: string, scope: string, keepRefreshToken?: string) {
    const accessToken = `mock_at_${randomBytes(16).toString('hex')}`;
    state.accessTokens.set(accessToken, { sub, scope, expiresAt: Date.now() + ttl * 1000 });
    const result: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ttl,
      scope,
    };
    if (issueRefresh) {
      const refreshToken = keepRefreshToken ?? `mock_rt_${randomBytes(16).toString('hex')}`;
      state.refreshTokens.set(refreshToken, { sub, scope });
      result.refresh_token = refreshToken;
    }
    return result;
  }

  return { app, state };
}
