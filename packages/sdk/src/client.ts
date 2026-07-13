import { errorFromResponse } from './errors.js';
import {
  DEFAULT_TIMEOUT_MS,
  type RequestEvent,
  type RetryConfig,
  type RetryEvent,
  requestWithRetry,
  resolveRetry,
} from './http.js';

/** Constructor options for {@link ConnectClient}. */
export interface ConnectClientOptions {
  /** Base URL of the Connect API, e.g. `https://connect.example.com`. */
  baseUrl: string;
  /** Bearer credential (PAT, session token, or workload JWT). */
  auth: string;
  /** Custom fetch implementation (testing, instrumentation). */
  fetch?: typeof fetch;
  /** Per-attempt request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Retry behavior. GET/PUT/DELETE retry on 5xx/429/network errors; POST/PATCH only on 429 or 503 with Retry-After. */
  retry?: RetryConfig;
  /** Called before every request attempt. */
  onRequest?: (event: RequestEvent) => void;
  /** Called before every retry wait. */
  onRetry?: (event: RetryEvent) => void;
}

/** Methods safe to replay after a network error or timeout. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Authenticated REST client for the Connect control plane (used by the CLI).
 * Shares the SDK's retry/timeout machinery; non-2xx responses throw the
 * typed {@link ConnectError} hierarchy via `errorFromResponse`.
 */
export class ConnectClient {
  private readonly retry: Required<RetryConfig>;

  constructor(private opts: ConnectClientOptions) {
    this.retry = resolveRetry(opts.retry);
  }

  /** Perform a request and parse the JSON response, throwing typed errors on non-2xx. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await requestWithRetry(
      doFetch,
      `${this.opts.baseUrl}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.opts.auth}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      {
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retry: this.retry,
        signal: options.signal,
        idempotent: IDEMPOTENT_METHODS.has(method.toUpperCase()),
        onRequest: this.opts.onRequest,
        onRetry: this.opts.onRetry,
      },
    );
    if (!res.ok) throw errorFromResponse(res.status, await res.json().catch(() => null));
    return (await res.json()) as T;
  }

  get<T>(path: string, options?: { signal?: AbortSignal }) {
    return this.request<T>('GET', path, undefined, options);
  }
  post<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) {
    return this.request<T>('POST', path, body, options);
  }
  put<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) {
    return this.request<T>('PUT', path, body, options);
  }
  patch<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) {
    return this.request<T>('PATCH', path, body, options);
  }
  delete<T>(path: string, options?: { signal?: AbortSignal }) {
    return this.request<T>('DELETE', path, undefined, options);
  }
}
