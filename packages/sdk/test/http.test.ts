import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectError } from '../src/errors.js';
import {
  type RequestOptions,
  type RetryEvent,
  requestWithRetry,
  resolveRetry,
} from '../src/http.js';
import { mockFetch } from './helpers.js';

const URL_ = 'http://api.test/v1/thing';

function opts(overrides: Partial<RequestOptions> = {}): RequestOptions {
  return {
    timeoutMs: 10_000,
    retry: resolveRetry(),
    idempotent: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // jitter factor becomes exactly 1.0 so delays are deterministic
  vi.spyOn(Math, 'random').mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveRetry', () => {
  it('fills defaults', () => {
    expect(resolveRetry()).toEqual({
      attempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 4000,
      retryAfterCapMs: 30_000,
    });
  });

  it('rejects invalid values', () => {
    expect(() => resolveRetry({ attempts: 0 })).toThrow(ConnectError);
    expect(() => resolveRetry({ baseDelayMs: -1 })).toThrow(ConnectError);
    expect(() => resolveRetry({ maxDelayMs: Number.NaN })).toThrow(ConnectError);
  });
});

describe('requestWithRetry', () => {
  it('retries 5xx with exponential backoff and returns the eventual success', async () => {
    const fetch_ = mockFetch([{ status: 500 }, { status: 502 }, { status: 200, body: { ok: 1 } }]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts());
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetch_.calls).toHaveLength(3);
    // delays: min(1000·2^0, 4000)=1000, then min(1000·2^1, 4000)=2000
    expect(fetch_.calls[1]!.at - fetch_.calls[0]!.at).toBe(1000);
    expect(fetch_.calls[2]!.at - fetch_.calls[1]!.at).toBe(2000);
  });

  it('caps backoff at maxDelayMs', async () => {
    const fetch_ = mockFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200, body: {} },
    ]);
    const promise = requestWithRetry(
      fetch_,
      URL_,
      {},
      opts({ retry: resolveRetry({ attempts: 4 }) }),
    );
    await vi.runAllTimersAsync();
    await promise;
    // third delay would be 4000 (min(1000·2^2, 4000))
    expect(fetch_.calls[3]!.at - fetch_.calls[2]!.at).toBe(4000);
  });

  it('does not retry 4xx (other than 429)', async () => {
    const fetch_ = mockFetch([{ status: 400, body: {} }]);
    const res = await requestWithRetry(fetch_, URL_, {}, opts());
    expect(res.status).toBe(400);
    expect(fetch_.calls).toHaveLength(1);
  });

  it('returns the last response when attempts are exhausted', async () => {
    const fetch_ = mockFetch([{ status: 500 }]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts());
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(500);
    expect(fetch_.calls).toHaveLength(3);
  });

  it('honors Retry-After seconds on 429 exactly', async () => {
    const fetch_ = mockFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: {} },
    ]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts());
    await vi.runAllTimersAsync();
    await promise;
    expect(fetch_.calls[1]!.at - fetch_.calls[0]!.at).toBe(2000);
  });

  it('honors Retry-After HTTP-dates', async () => {
    // whole-second clock so the second-granularity HTTP-date is exact
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const date = new Date(Date.now() + 5000).toUTCString();
    const fetch_ = mockFetch([
      { status: 429, headers: { 'retry-after': date } },
      { status: 200, body: {} },
    ]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts());
    await vi.runAllTimersAsync();
    await promise;
    expect(fetch_.calls[1]!.at - fetch_.calls[0]!.at).toBe(5000);
  });

  it('gives up immediately when Retry-After exceeds the cap', async () => {
    const fetch_ = mockFetch([{ status: 429, headers: { 'retry-after': '60' } }]);
    const res = await requestWithRetry(fetch_, URL_, {}, opts());
    expect(res.status).toBe(429);
    expect(fetch_.calls).toHaveLength(1);
  });

  it('retries network errors on idempotent requests, then throws network_error', async () => {
    const fetch_ = mockFetch([{ error: new Error('ECONNREFUSED') }]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts());
    const assertion = expect(promise).rejects.toMatchObject({ code: 'network_error' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch_.calls).toHaveLength(3);
  });

  it('does not retry network errors on non-idempotent requests', async () => {
    const fetch_ = mockFetch([{ error: new Error('boom') }]);
    await expect(
      requestWithRetry(fetch_, URL_, { method: 'POST' }, opts({ idempotent: false })),
    ).rejects.toMatchObject({ code: 'network_error' });
    expect(fetch_.calls).toHaveLength(1);
  });

  it('does not retry 5xx on non-idempotent requests without Retry-After', async () => {
    const fetch_ = mockFetch([{ status: 500 }]);
    const res = await requestWithRetry(
      fetch_,
      URL_,
      { method: 'POST' },
      opts({ idempotent: false }),
    );
    expect(res.status).toBe(500);
    expect(fetch_.calls).toHaveLength(1);
  });

  it('retries 429 even on non-idempotent requests', async () => {
    const fetch_ = mockFetch([{ status: 429 }, { status: 200, body: {} }]);
    const promise = requestWithRetry(fetch_, URL_, { method: 'POST' }, opts({ idempotent: false }));
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetch_.calls).toHaveLength(2);
  });

  it('retries 503 with Retry-After on non-idempotent requests', async () => {
    const fetch_ = mockFetch([
      { status: 503, headers: { 'retry-after': '1' } },
      { status: 200, body: {} },
    ]);
    const promise = requestWithRetry(fetch_, URL_, { method: 'POST' }, opts({ idempotent: false }));
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetch_.calls).toHaveLength(2);
  });

  it('times out a hung request and retries, surfacing code "timeout" when exhausted', async () => {
    const fetch_ = mockFetch([{ hang: true }]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts({ timeoutMs: 1000 }));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch_.calls).toHaveLength(3);
  });

  it('recovers when a later attempt succeeds after a timeout', async () => {
    const fetch_ = mockFetch([{ hang: true }, { status: 200, body: {} }]);
    const promise = requestWithRetry(fetch_, URL_, {}, opts({ timeoutMs: 1000 }));
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetch_.calls).toHaveLength(2);
  });

  it('a caller abort rethrows immediately and is never retried', async () => {
    const fetch_ = mockFetch([{ hang: true }]);
    const controller = new AbortController();
    const reason = new Error('caller gave up');
    const promise = requestWithRetry(fetch_, URL_, {}, opts({ signal: controller.signal }));
    const assertion = expect(promise).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(fetch_.calls).toHaveLength(1);
  });

  it('an already-aborted signal fails before any fetch', async () => {
    const fetch_ = mockFetch([{ status: 200, body: {} }]);
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await expect(
      requestWithRetry(fetch_, URL_, {}, opts({ signal: controller.signal })),
    ).rejects.toThrow('pre-aborted');
    expect(fetch_.calls).toHaveLength(0);
  });

  it('emits onRequest and onRetry events', async () => {
    const requests: number[] = [];
    const retries: RetryEvent[] = [];
    const fetch_ = mockFetch([{ status: 500 }, { status: 200, body: {} }]);
    const promise = requestWithRetry(
      fetch_,
      URL_,
      { method: 'POST' },
      opts({
        onRequest: (e) => requests.push(e.attempt),
        onRetry: (e) => retries.push(e),
      }),
    );
    await vi.runAllTimersAsync();
    await promise;
    expect(requests).toEqual([0, 1]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 0, status: 500, method: 'POST', delayMs: 1000 });
  });
});
