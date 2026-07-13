import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectClient } from '../src/client.js';
import { mockFetch } from './helpers.js';

const BASE = 'http://api.test';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ConnectClient', () => {
  it('sends the bearer auth header and parses JSON', async () => {
    const fetch_ = mockFetch([{ status: 200, body: { hello: 'world' } }]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 'cn_pat_1', fetch: fetch_ });
    const result = await client.get<{ hello: string }>('/v1/me');
    expect(result).toEqual({ hello: 'world' });
    expect(fetch_.calls[0]!.url).toBe(`${BASE}/v1/me`);
    expect((fetch_.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer cn_pat_1',
    );
  });

  it('serializes bodies and sets content-type on POST', async () => {
    const fetch_ = mockFetch([{ status: 200, body: { id: '1' } }]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await client.post('/v1/connectors', { slug: 'github' });
    const call = fetch_.calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe(JSON.stringify({ slug: 'github' }));
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('omits content-type when there is no body', async () => {
    const fetch_ = mockFetch([{ status: 200, body: {} }]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await client.delete('/v1/connectors/x');
    const headers = fetch_.calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('maps error responses to typed ConnectErrors', async () => {
    const fetch_ = mockFetch([
      { status: 404, body: { error: { code: 'not_found', message: 'nope' } } },
    ]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await expect(client.get('/v1/missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'nope',
    });
  });

  it('retries GET on 5xx', async () => {
    const fetch_ = mockFetch([{ status: 500 }, { status: 200, body: { ok: true } }]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    const promise = client.get('/v1/me');
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetch_.calls).toHaveLength(2);
  });

  it('does not retry POST on 5xx', async () => {
    const fetch_ = mockFetch([
      { status: 500, body: { error: { code: 'internal_error', message: 'boom' } } },
    ]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    await expect(client.post('/v1/connectors', {})).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(fetch_.calls).toHaveLength(1);
  });

  it('retries POST on 429', async () => {
    const fetch_ = mockFetch([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, body: { ok: true } },
    ]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    const promise = client.post('/v1/connectors', {});
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetch_.calls).toHaveLength(2);
  });

  it('supports per-request abort signals', async () => {
    const fetch_ = mockFetch([{ hang: true }]);
    const client = new ConnectClient({ baseUrl: BASE, auth: 't', fetch: fetch_ });
    const controller = new AbortController();
    const reason = new Error('stop');
    const promise = client.get('/v1/me', { signal: controller.signal });
    const assertion = expect(promise).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(fetch_.calls).toHaveLength(1);
  });
});
