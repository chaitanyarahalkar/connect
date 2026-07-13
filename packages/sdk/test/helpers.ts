import { vi } from 'vitest';

export interface MockCall {
  url: string;
  init: RequestInit;
  /** Faked Date.now() at call time — lets tests assert exact backoff delays. */
  at: number;
}

export type MockResponseSpec =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { error: Error }
  | { hang: true };

/** A valid /v1/tokens response body. */
export function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok_123',
    tokenType: 'bearer',
    expiresAt: new Date(Date.now() + 1_000_000).toISOString(),
    scopes: ['repo'],
    connectorId: 'conn_1',
    installationId: null,
    cached: false,
    ...overrides,
  };
}

/**
 * Queue-based fetch mock: each call consumes the next spec (the last spec
 * repeats once the queue is exhausted). `hang` specs never resolve unless
 * the request signal aborts.
 */
export function mockFetch(specs: MockResponseSpec[]) {
  const queue = [...specs];
  const calls: MockCall[] = [];
  const fn = vi.fn(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(url), init, at: Date.now() });
      const spec = queue.length > 1 ? (queue.shift() as MockResponseSpec) : queue[0];
      if (!spec) throw new Error('mockFetch: no response spec queued');
      if ('error' in spec) throw spec.error;
      if ('hang' in spec) {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        });
      }
      return new Response(spec.body === undefined ? null : JSON.stringify(spec.body), {
        status: spec.status,
        headers: { 'content-type': 'application/json', ...spec.headers },
      });
    },
  );
  return Object.assign(fn as unknown as typeof fetch, { calls });
}
