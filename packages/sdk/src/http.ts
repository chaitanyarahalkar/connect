import { ConnectError } from './errors.js';

/** Default per-attempt timeout applied when none is configured. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Retry behavior for requests made by the SDK. All fields optional. */
export interface RetryConfig {
  /** Total attempts, including the first. Default 3. Set 1 to disable retries. */
  attempts?: number;
  /** Base of the exponential backoff in milliseconds. Default 1000. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay (before jitter). Default 4000. */
  maxDelayMs?: number;
  /**
   * Longest `Retry-After` the SDK will honor, in milliseconds. A 429/503
   * whose `Retry-After` exceeds this cap is returned immediately instead of
   * waited on. Default 30000.
   */
  retryAfterCapMs?: number;
}

/** Emitted through {@link RequestHooks.onRequest} before every attempt. */
export interface RequestEvent {
  url: string;
  method: string;
  /** 0-based attempt counter. */
  attempt: number;
}

/** Emitted through {@link RequestHooks.onRetry} before every retry wait. */
export interface RetryEvent {
  url: string;
  method: string;
  /** 0-based attempt that just failed. */
  attempt: number;
  /** How long the SDK will wait before the next attempt. */
  delayMs: number;
  /** HTTP status that triggered the retry, when the server responded. */
  status?: number;
  /** The thrown error that triggered the retry, for network/timeout failures. */
  error?: unknown;
}

/** Optional observability callbacks. Compose with any logger or metrics client. */
export interface RequestHooks {
  /** Called before every attempt (including the first). */
  onRequest?: (event: RequestEvent) => void;
  /** Called before every retry wait, with the reason. */
  onRetry?: (event: RetryEvent) => void;
}

export interface RequestOptions extends RequestHooks {
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  retry: Required<RetryConfig>;
  /** Caller-provided abort signal; aborting it fails the request immediately, with no retry. */
  signal?: AbortSignal;
  /**
   * Whether the request is safe to replay after a network error or timeout.
   * Non-idempotent requests are still retried on 429 (the server did not
   * process them) and on 503 with a `Retry-After` header.
   */
  idempotent: boolean;
}

const DEFAULT_RETRY: Required<RetryConfig> = {
  attempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 4000,
  retryAfterCapMs: 30_000,
};

/** Fill a partial {@link RetryConfig} with defaults, validating the values. */
export function resolveRetry(retry: RetryConfig = {}): Required<RetryConfig> {
  const resolved = { ...DEFAULT_RETRY, ...retry };
  if (!Number.isInteger(resolved.attempts) || resolved.attempts < 1) {
    throw new ConnectError('validation_error', `retry.attempts must be a positive integer`);
  }
  for (const field of ['baseDelayMs', 'maxDelayMs', 'retryAfterCapMs'] as const) {
    if (!Number.isFinite(resolved[field]) || resolved[field] < 0) {
      throw new ConnectError('validation_error', `retry.${field} must be a non-negative number`);
    }
  }
  return resolved;
}

/**
 * `fetch` with per-attempt timeout, exponential backoff, `Retry-After`
 * support, and caller-abort passthrough. Used by both the token client and
 * the REST wrapper so every SDK request shares one resilience policy.
 *
 * Retries on: network errors and timeouts (idempotent requests only), 429
 * (always — the server did not process the request), and 5xx (idempotent
 * requests, or 503 carrying `Retry-After`).
 */
export async function requestWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  opts: RequestOptions,
): Promise<Response> {
  const { attempts } = opts.retry;
  const method = (init.method ?? 'GET').toUpperCase();
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfAborted(opts.signal);
    opts.onRequest?.({ url, method, attempt });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
    const forwardAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      const delayMs = statusRetryDelay(res, attempt, opts);
      if (delayMs === null) return res;
      res.body?.cancel().catch(() => {});
      opts.onRetry?.({ url, method, attempt, delayMs, status: res.status });
      await sleep(delayMs, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted && !timedOut) {
        throw opts.signal.reason ?? err;
      }
      lastError = timedOut
        ? new ConnectError('timeout', `request to ${url} timed out after ${opts.timeoutMs}ms`)
        : err;
      if (!opts.idempotent || attempt >= attempts - 1) break;
      const delayMs = backoffDelay(attempt, opts.retry);
      opts.onRetry?.({ url, method, attempt, delayMs, error: lastError });
      await sleep(delayMs, opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  if (lastError instanceof ConnectError) throw lastError;
  throw new ConnectError('network_error', `request to ${url} failed: ${String(lastError)}`);
}

/**
 * Decide whether a response should be retried. Returns the delay to wait in
 * ms, or `null` to return the response to the caller as-is.
 */
function statusRetryDelay(res: Response, attempt: number, opts: RequestOptions): number | null {
  const { status } = res;
  if (status !== 429 && status < 500) return null;
  if (attempt >= opts.retry.attempts - 1) return null;

  const retryAfterMs = status === 429 || status === 503 ? parseRetryAfter(res) : null;
  // Non-idempotent requests: only a 429 (not processed) or an explicit
  // 503 Retry-After is safe to replay.
  if (!opts.idempotent && status !== 429 && retryAfterMs === null) return null;
  if (retryAfterMs !== null) {
    if (retryAfterMs > opts.retry.retryAfterCapMs) return null;
    return retryAfterMs;
  }
  return backoffDelay(attempt, opts.retry);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to milliseconds. */
function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Exponential backoff with 0.5–1.0 jitter: min(base·2^attempt, max) · jitter. */
function backoffDelay(attempt: number, retry: Required<RetryConfig>): number {
  const ms = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  return ms * (0.5 + Math.random() / 2);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
  }
}

/** Timer-based sleep that ends early (resolving) if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
