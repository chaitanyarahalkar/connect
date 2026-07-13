import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokenCache, getToken, UserAuthorizationRequiredError } from '../src/index.js';
import { mockFetch, tokenBody } from './helpers.js';

const BASE = 'http://api.test';

beforeEach(() => {
  vi.useFakeTimers();
  clearTokenCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('module-level getToken (back-compat contract)', () => {
  it('fetches with per-call baseUrl/auth/fetch options and caches process-wide', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    const first = await getToken(
      { connector: 'github', scopes: ['repo'] },
      { baseUrl: BASE, auth: 'cn_pat_1', fetch: fetch_ },
    );
    expect(first.token).toBe('tok_123');
    expect(first.expiresAt).toBeInstanceOf(Date);
    expect(fetch_.calls[0]!.url).toBe(`${BASE}/v1/tokens`);
    expect(JSON.parse(String(fetch_.calls[0]!.init.body))).toMatchObject({
      connector: 'github',
      scopes: ['repo'],
      subject: { type: 'app' },
    });

    const again = await getToken(
      { connector: 'github', scopes: ['repo'] },
      { baseUrl: BASE, auth: 'cn_pat_1', fetch: fetch_ },
    );
    expect(again).toBe(first);
    expect(fetch_.calls).toHaveLength(1);
  });

  it('clearTokenCache drops the shared cache', async () => {
    const fetch_ = mockFetch([{ status: 200, body: tokenBody() }]);
    await getToken({ connector: 'github' }, { baseUrl: BASE, auth: 't', fetch: fetch_ });
    clearTokenCache();
    await getToken({ connector: 'github' }, { baseUrl: BASE, auth: 't', fetch: fetch_ });
    expect(fetch_.calls).toHaveLength(2);
  });

  it('throws the documented typed errors', async () => {
    const fetch_ = mockFetch([
      {
        status: 409,
        body: { error: { code: 'user_authorization_required', message: 'go authorize' } },
      },
    ]);
    await expect(
      getToken(
        { connector: 'github', subject: { type: 'user', userId: 'user_123' } },
        { baseUrl: BASE, auth: 't', fetch: fetch_ },
      ),
    ).rejects.toBeInstanceOf(UserAuthorizationRequiredError);
  });
});
