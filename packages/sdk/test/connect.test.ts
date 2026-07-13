import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connect } from '../src/connect.js';
import { ConnectError } from '../src/errors.js';
import { mockFetch, tokenBody } from './helpers.js';

const BASE = 'http://api.test';
const ENV_KEYS = [
  'CONNECT_API_URL',
  'CONNECT_OIDC_TOKEN',
  'CONNECT_CLIENT_ID',
  'CONNECT_CLIENT_SECRET',
  'CONNECT_ACCESS_TOKEN',
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Connect config validation', () => {
  it.each([
    [{ timeoutMs: 0 }],
    [{ timeoutMs: Number.NaN }],
    [{ cacheSize: 0 }],
    [{ cacheSize: 2.5 }],
    [{ refreshAheadFraction: 0 }],
    [{ refreshAheadFraction: 1.5 }],
    [{ validityBufferMs: -1 }],
    [{ retry: { attempts: 0 } }],
  ])('rejects %o', (config) => {
    let thrown: unknown;
    try {
      new Connect(config);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectError);
    expect((thrown as ConnectError).code).toBe('validation_error');
  });
});

describe('getToken param validation', () => {
  const connect = () => new Connect({ baseUrl: BASE, auth: 't', fetch: mockFetch([]) });

  it.each([
    [{ connector: '' }],
    [{ connector: 'c', installationId: '' }],
    [{ connector: 'c', scopes: ['ok', ''] }],
    [{ connector: 'c', subject: { type: 'user' } }],
    [{ connector: 'c', subject: { type: 'jwt-bearer' } }],
    [{ connector: 'c', subject: { type: 'nope' } }],
    [{ connector: 'c', validityBufferMs: -5 }],
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed inputs
  ])('rejects %o with validation_error', async (params: any) => {
    await expect(connect().getToken(params)).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('token caching', () => {
  it('serves repeat calls from cache with a single fetch', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    const first = await c.getToken({ connector: 'github' });
    const again = await c.getToken({ connector: 'github' });
    expect(first.token).toBe('tok_123');
    expect(again).toBe(first);
    expect(fetch_.calls).toHaveLength(1);
  });

  it('normalizes scope order in the cache key', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github', scopes: ['repo', 'user'] });
    await c.getToken({ connector: 'github', scopes: ['user', 'repo'] });
    expect(fetch_.calls).toHaveLength(1);
  });

  it('keys the cache by base URL so hosts cannot cross-contaminate', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' }, { baseUrl: 'http://a.test' });
    await c.getToken({ connector: 'github' }, { baseUrl: 'http://b.test' });
    expect(fetch_.calls).toHaveLength(2);
    expect(fetch_.calls[0]!.url).toBe('http://a.test/v1/tokens');
    expect(fetch_.calls[1]!.url).toBe('http://b.test/v1/tokens');
  });

  it('evicts least recently used entries, not oldest', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_, cacheSize: 2 });
    await c.getToken({ connector: 'a' });
    await c.getToken({ connector: 'b' });
    await c.getToken({ connector: 'a' }); // refresh a's recency
    await c.getToken({ connector: 'c' }); // evicts b
    expect(fetch_.calls).toHaveLength(3);
    await c.getToken({ connector: 'a' }); // still cached
    expect(fetch_.calls).toHaveLength(3);
    await c.getToken({ connector: 'b' }); // evicted → refetch
    expect(fetch_.calls).toHaveLength(4);
  });

  it('refetches once the validity buffer is reached', async () => {
    const fetch_ = mockFetch([
      { status: 200, body: tokenBody({ expiresAt: new Date(Date.now() + 60_000).toISOString() }) },
      { status: 200, body: tokenBody({ token: 'tok_next' }) },
    ]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    // 60s lifetime, 30s buffer → stale after 30s
    await vi.advanceTimersByTimeAsync(31_000);
    const fresh = await c.getToken({ connector: 'github' });
    expect(fresh.token).toBe('tok_next');
    expect(fetch_.calls).toHaveLength(2);
  });

  it('clearCache forces a refetch', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    c.clearCache();
    await c.getToken({ connector: 'github' });
    expect(fetch_.calls).toHaveLength(2);
  });

  it('maps error responses to typed errors', async () => {
    const fetch_ = mockFetch([
      {
        status: 409,
        body: { error: { code: 'user_authorization_required', message: 'authorize first' } },
      },
    ]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await expect(c.getToken({ connector: 'github' })).rejects.toMatchObject({
      code: 'user_authorization_required',
      status: 409,
    });
  });
});

describe('refresh-ahead', () => {
  const lifetimeMs = 1_000_000; // buffer 30s ≪ 20% of lifetime, so refresh-ahead wins

  function freshBody(token: string) {
    return tokenBody({ token, expiresAt: new Date(Date.now() + lifetimeMs).toISOString() });
  }

  it('does not refresh before the threshold of observed lifetime', async () => {
    const fetch_ = mockFetch([{ status: 200, body: freshBody('tok_1') }]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    await vi.advanceTimersByTimeAsync(lifetimeMs * 0.79);
    await c.getToken({ connector: 'github' });
    expect(fetch_.calls).toHaveLength(1);
  });

  it('refreshes in the background past the threshold while serving the cached token', async () => {
    const fetch_ = mockFetch([
      { status: 200, body: freshBody('tok_1') },
      { status: 200, body: freshBody('tok_2') },
    ]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    await vi.advanceTimersByTimeAsync(lifetimeMs * 0.81);
    const stillCached = await c.getToken({ connector: 'github' });
    expect(stillCached.token).toBe('tok_1'); // caller not blocked on the refresh
    await vi.runAllTimersAsync(); // let the background refresh land
    const refreshed = await c.getToken({ connector: 'github' });
    expect(refreshed.token).toBe('tok_2');
    expect(fetch_.calls).toHaveLength(2);
  });

  it('starts only one background refresh across many hits', async () => {
    const fetch_ = mockFetch([
      { status: 200, body: freshBody('tok_1') },
      { status: 200, body: freshBody('tok_2') },
    ]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    await vi.advanceTimersByTimeAsync(lifetimeMs * 0.81);
    await Promise.all([
      c.getToken({ connector: 'github' }),
      c.getToken({ connector: 'github' }),
      c.getToken({ connector: 'github' }),
    ]);
    await vi.runAllTimersAsync();
    expect(fetch_.calls).toHaveLength(2);
  });

  it('keeps serving the stale-but-valid token when the refresh fails', async () => {
    const fetch_ = mockFetch([
      { status: 200, body: freshBody('tok_1') },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    await vi.advanceTimersByTimeAsync(lifetimeMs * 0.81);
    const served = await c.getToken({ connector: 'github' });
    expect(served.token).toBe('tok_1');
    await vi.runAllTimersAsync();
    // still valid, still served, refresh re-armed rather than crashing
    const after = await c.getToken({ connector: 'github' });
    expect(after.token).toBe('tok_1');
  });

  it('skips refresh-ahead for very short-lived tokens', async () => {
    const fetch_ = mockFetch([
      { status: 200, body: tokenBody({ expiresAt: new Date(Date.now() + 50_000).toISOString() }) },
    ]);
    // lifetime 50s < 2× the 30s buffer → no refresh-ahead
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    await vi.advanceTimersByTimeAsync(15_000);
    await c.getToken({ connector: 'github' });
    expect(fetch_.calls).toHaveLength(1);
  });
});

describe('single-flight', () => {
  it('de-dupes concurrent cold calls into one fetch', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => c.getToken({ connector: 'github' })),
    );
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
    expect(fetch_.calls).toHaveLength(1);
  });

  it('mints one workload JWT for concurrent cold calls to different connectors', async () => {
    vi.stubEnv('CONNECT_CLIENT_ID', 'pc_1');
    vi.stubEnv('CONNECT_CLIENT_SECRET', 'pcs_1');
    const fetch_ = mockFetch([
      { status: 200, body: { access_token: 'jwt_1', expires_in: 600 } },
      { status: 200, body: tokenBody() },
    ]);
    const c = new Connect({ baseUrl: BASE, fetch: fetch_ });
    await Promise.all([c.getToken({ connector: 'a' }), c.getToken({ connector: 'b' })]);
    const mints = fetch_.calls.filter((call) => call.url.endsWith('/v1/oidc/token'));
    expect(mints).toHaveLength(1);
    expect(fetch_.calls).toHaveLength(3); // 1 mint + 2 token fetches
  });
});

describe('auth resolution', () => {
  function authHeader(init: RequestInit): string | undefined {
    return (init.headers as Record<string, string>).authorization;
  }

  it('explicit auth wins over everything', async () => {
    vi.stubEnv('CONNECT_OIDC_TOKEN', 'env-oidc');
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, auth: 'explicit', fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    expect(authHeader(fetch_.calls[0]!.init)).toBe('Bearer explicit');
  });

  it('uses CONNECT_OIDC_TOKEN before client credentials', async () => {
    vi.stubEnv('CONNECT_OIDC_TOKEN', 'env-oidc');
    vi.stubEnv('CONNECT_CLIENT_ID', 'pc_1');
    vi.stubEnv('CONNECT_CLIENT_SECRET', 'pcs_1');
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    expect(fetch_.calls).toHaveLength(1);
    expect(authHeader(fetch_.calls[0]!.init)).toBe('Bearer env-oidc');
  });

  it('self-mints from client credentials and caches the JWT until near expiry', async () => {
    vi.stubEnv('CONNECT_CLIENT_ID', 'pc_1');
    vi.stubEnv('CONNECT_CLIENT_SECRET', 'pcs_1');
    const fetch_ = mockFetch([
      { status: 200, body: { access_token: 'jwt_1', expires_in: 600 } },
      { status: 200, body: tokenBody() },
    ]);
    const c = new Connect({ baseUrl: BASE, fetch: fetch_ });
    await c.getToken({ connector: 'a' });
    await c.getToken({ connector: 'b' });
    const mints = fetch_.calls.filter((call) => call.url.endsWith('/v1/oidc/token'));
    expect(mints).toHaveLength(1);
    expect(authHeader(fetch_.calls[1]!.init)).toBe('Bearer jwt_1');

    // advance past the JWT's lifetime → re-mint
    await vi.advanceTimersByTimeAsync(600_000);
    await c.getToken({ connector: 'c' });
    expect(fetch_.calls.filter((call) => call.url.endsWith('/v1/oidc/token'))).toHaveLength(2);
  });

  it('retries the self-mint on 5xx', async () => {
    vi.stubEnv('CONNECT_CLIENT_ID', 'pc_1');
    vi.stubEnv('CONNECT_CLIENT_SECRET', 'pcs_1');
    const fetch_ = mockFetch([
      { status: 500 },
      { status: 200, body: { access_token: 'jwt_1', expires_in: 600 } },
      { status: 200, body: tokenBody() },
    ]);
    const c = new Connect({ baseUrl: BASE, fetch: fetch_ });
    const promise = c.getToken({ connector: 'github' });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetch_.calls.filter((call) => call.url.endsWith('/v1/oidc/token'))).toHaveLength(2);
  });

  it('falls back to CONNECT_ACCESS_TOKEN', async () => {
    vi.stubEnv('CONNECT_ACCESS_TOKEN', 'cn_pat_x');
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, fetch: fetch_ });
    await c.getToken({ connector: 'github' });
    expect(authHeader(fetch_.calls[0]!.init)).toBe('Bearer cn_pat_x');
  });

  it('throws unauthorized when no credentials are available', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const c = new Connect({ baseUrl: BASE, fetch: fetch_ });
    await expect(c.getToken({ connector: 'github' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(fetch_.calls).toHaveLength(0);
  });
});
