import type { TokenRequest, TokenResponse } from '@connect/shared';
import { ConnectError, errorFromResponse } from './errors.js';
import {
  DEFAULT_TIMEOUT_MS,
  type RequestEvent,
  type RetryConfig,
  type RetryEvent,
  requestWithRetry,
  resolveRetry,
} from './http.js';
import { LruMap } from './lru.js';

/** Parameters identifying the provider token to mint. */
export interface GetTokenParams {
  /** Connector slug or id, e.g. `'github'`. */
  connector: string;
  /** Pin a specific installation when the connector has several. */
  installationId?: string;
  /** Who the token acts as. Default `{ type: 'app' }`. */
  subject?: TokenRequest['subject'];
  /** Provider scopes to request. Order-insensitive for caching. */
  scopes?: string[];
  /** RFC 8707 resource indicator, when the provider supports it. */
  resource?: string;
  /** RFC 9396 authorization details, when the provider supports them. */
  authorizationDetails?: Record<string, unknown>[];
  /** Treat a cached token as stale this many ms before expiry. Default 30s. */
  validityBufferMs?: number;
}

/** Per-request overrides accepted by {@link Connect.getToken} and the module-level `getToken`. */
export interface ConnectOptions {
  /** Base URL of the Connect API. Default: `CONNECT_API_URL` or `http://localhost:4000`. */
  baseUrl?: string;
  /** Explicit credential; overrides env-based auth resolution. */
  auth?: string;
  /** Custom fetch implementation (testing, instrumentation). */
  fetch?: typeof fetch;
}

/** Per-call options: everything in {@link ConnectOptions} plus an abort signal. */
export interface GetTokenOptions extends ConnectOptions {
  /** Abort the call (including retries). Does not cancel background refreshes. */
  signal?: AbortSignal;
}

/** Constructor configuration for {@link Connect}. Every field has a sensible default. */
export interface ConnectConfig extends ConnectOptions {
  /** Per-attempt request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Retry behavior for all requests. See {@link RetryConfig}. */
  retry?: RetryConfig;
  /** Max distinct token cache entries (LRU-evicted). Default 100. */
  cacheSize?: number;
  /** Default staleness buffer before expiry, in ms. Default 30000. */
  validityBufferMs?: number;
  /**
   * Fraction of a token's observed lifetime after which a background
   * refresh is started on cache hits. Default 0.8 (refresh once 80% of the
   * lifetime has elapsed).
   */
  refreshAheadFraction?: number;
  /** Called before every request attempt. */
  onRequest?: (event: RequestEvent) => void;
  /** Called before every retry wait. */
  onRetry?: (event: RetryEvent) => void;
}

/** A short-lived provider token minted by Connect. */
export interface ConnectToken {
  token: string;
  tokenType: 'bearer' | 'api_key';
  expiresAt: Date;
  scopes: string[];
  connectorId: string;
  installationId: string | null;
}

interface CacheEntry {
  value: ConnectToken;
  /** When this token was fetched — with `expiresAt` it gives the observed lifetime. */
  fetchedAt: number;
  refreshing: Promise<ConnectToken> | null;
}

const DEFAULT_VALIDITY_BUFFER_MS = 30_000;
const DEFAULT_REFRESH_AHEAD_FRACTION = 0.8;
const DEFAULT_CACHE_SIZE = 100;
/** Self-minted workload JWTs are considered expired this many ms early. */
const WORKLOAD_TOKEN_BUFFER_MS = 30_000;

/**
 * Connect token client. Owns an in-process LRU token cache with
 * refresh-ahead, single-flight de-duplication of concurrent fetches, and
 * workload-identity auth — all isolated per instance.
 *
 * ```ts
 * const connect = new Connect({ timeoutMs: 5000 });
 * const { token } = await connect.getToken({ connector: 'github', scopes: ['repo'] });
 * ```
 *
 * Auth resolution order: `auth` option → `CONNECT_OIDC_TOKEN` →
 * `CONNECT_CLIENT_ID`/`CONNECT_CLIENT_SECRET` (self-mints a workload JWT) →
 * `CONNECT_ACCESS_TOKEN`.
 */
export class Connect {
  private readonly config: ConnectConfig;
  private readonly retry: Required<RetryConfig>;
  private readonly timeoutMs: number;
  private readonly validityBufferMs: number;
  private readonly refreshAheadFraction: number;
  private readonly cache: LruMap<string, CacheEntry>;
  private readonly inflight = new Map<string, Promise<ConnectToken>>();
  private workloadToken: { token: string; expiresAt: number } | null = null;
  private workloadTokenInflight: Promise<string> | null = null;

  constructor(config: ConnectConfig = {}) {
    this.retry = resolveRetry(config.retry);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ConnectError('validation_error', 'timeoutMs must be a positive number');
    }
    this.validityBufferMs = config.validityBufferMs ?? DEFAULT_VALIDITY_BUFFER_MS;
    if (!Number.isFinite(this.validityBufferMs) || this.validityBufferMs < 0) {
      throw new ConnectError('validation_error', 'validityBufferMs must be a non-negative number');
    }
    this.refreshAheadFraction = config.refreshAheadFraction ?? DEFAULT_REFRESH_AHEAD_FRACTION;
    if (
      !Number.isFinite(this.refreshAheadFraction) ||
      this.refreshAheadFraction <= 0 ||
      this.refreshAheadFraction > 1
    ) {
      throw new ConnectError('validation_error', 'refreshAheadFraction must be in (0, 1]');
    }
    const cacheSize = config.cacheSize ?? DEFAULT_CACHE_SIZE;
    if (!Number.isInteger(cacheSize) || cacheSize < 1) {
      throw new ConnectError('validation_error', 'cacheSize must be a positive integer');
    }
    this.cache = new LruMap(cacheSize);
    this.config = config;
  }

  /**
   * Request a short-lived provider token.
   *
   * Serves from the in-process cache while the token is valid, refreshing it
   * in the background once {@link ConnectConfig.refreshAheadFraction} of its
   * observed lifetime has elapsed. Concurrent calls for the same token are
   * de-duplicated into one request.
   */
  async getToken(params: GetTokenParams, overrides: GetTokenOptions = {}): Promise<ConnectToken> {
    validateGetTokenParams(params);
    const baseUrl = this.resolveBaseUrl(overrides);
    const key = cacheKeyFor(baseUrl, params);
    const buffer = params.validityBufferMs ?? this.validityBufferMs;
    const entry = this.cache.get(key);

    if (entry) {
      const now = Date.now();
      const expiresAt = entry.value.expiresAt.getTime();
      if (expiresAt - buffer > now) {
        const lifetime = expiresAt - entry.fetchedAt;
        // Refresh ahead of expiry, but skip tokens so short-lived that
        // refreshing early would just thrash the server.
        if (
          lifetime > 2 * buffer &&
          now >= entry.fetchedAt + lifetime * this.refreshAheadFraction &&
          !entry.refreshing
        ) {
          // Background refresh: deliberately not tied to the caller's signal.
          const { signal: _signal, ...rest } = overrides;
          entry.refreshing = this.fetchToken(params, rest)
            .then((fresh) => {
              this.cache.set(key, { value: fresh, fetchedAt: Date.now(), refreshing: null });
              return fresh;
            })
            .catch(() => {
              entry.refreshing = null;
              return entry.value;
            });
        }
        return entry.value;
      }
    }

    // Stale or missing: de-dupe concurrent callers onto one fetch.
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.fetchToken(params, overrides)
      .then((fresh) => {
        this.cache.set(key, { value: fresh, fetchedAt: Date.now(), refreshing: null });
        return fresh;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop all cached tokens, in-flight de-dup state, and the cached workload JWT. */
  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
    this.workloadToken = null;
    this.workloadTokenInflight = null;
  }

  private resolveBaseUrl(overrides: ConnectOptions): string {
    return (
      overrides.baseUrl ??
      this.config.baseUrl ??
      process.env.CONNECT_API_URL ??
      'http://localhost:4000'
    );
  }

  private resolveFetch(overrides: ConnectOptions): typeof fetch {
    return overrides.fetch ?? this.config.fetch ?? fetch;
  }

  private async fetchToken(
    params: GetTokenParams,
    overrides: GetTokenOptions,
  ): Promise<ConnectToken> {
    const baseUrl = this.resolveBaseUrl(overrides);
    const doFetch = this.resolveFetch(overrides);
    const auth = await this.resolveAuth(baseUrl, overrides, doFetch);

    const body: TokenRequest = {
      connector: params.connector,
      installationId: params.installationId,
      subject: params.subject ?? { type: 'app' },
      scopes: params.scopes,
      resource: params.resource,
      authorizationDetails: params.authorizationDetails,
    };

    const res = await requestWithRetry(
      doFetch,
      `${baseUrl}/v1/tokens`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: this.timeoutMs,
        retry: this.retry,
        signal: overrides.signal,
        // Token minting is safe to replay: the server de-dupes via its own cache.
        idempotent: true,
        onRequest: this.config.onRequest,
        onRetry: this.config.onRetry,
      },
    );

    if (!res.ok) {
      throw errorFromResponse(res.status, await res.json().catch(() => null));
    }
    const data = (await res.json()) as TokenResponse;
    return {
      token: data.token,
      tokenType: data.tokenType,
      expiresAt: new Date(data.expiresAt),
      scopes: data.scopes,
      connectorId: data.connectorId,
      installationId: data.installationId,
    };
  }

  private async resolveAuth(
    baseUrl: string,
    overrides: ConnectOptions,
    doFetch: typeof fetch,
  ): Promise<string> {
    const explicit = overrides.auth ?? this.config.auth;
    if (explicit) return explicit;
    if (process.env.CONNECT_OIDC_TOKEN) return process.env.CONNECT_OIDC_TOKEN;

    const clientId = process.env.CONNECT_CLIENT_ID;
    const clientSecret = process.env.CONNECT_CLIENT_SECRET;
    if (clientId && clientSecret) {
      if (
        this.workloadToken &&
        this.workloadToken.expiresAt - WORKLOAD_TOKEN_BUFFER_MS > Date.now()
      ) {
        return this.workloadToken.token;
      }
      // Single-flight the self-mint so N concurrent cold calls mint one JWT.
      // Not tied to any caller's signal: the result is shared.
      this.workloadTokenInflight ??= this.mintWorkloadToken(
        baseUrl,
        doFetch,
        clientId,
        clientSecret,
      ).finally(() => {
        this.workloadTokenInflight = null;
      });
      return this.workloadTokenInflight;
    }

    if (process.env.CONNECT_ACCESS_TOKEN) return process.env.CONNECT_ACCESS_TOKEN;
    throw new ConnectError(
      'unauthorized',
      'no Connect credentials found: set CONNECT_OIDC_TOKEN, CONNECT_CLIENT_ID/CONNECT_CLIENT_SECRET, or CONNECT_ACCESS_TOKEN',
    );
  }

  private async mintWorkloadToken(
    baseUrl: string,
    doFetch: typeof fetch,
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    const res = await requestWithRetry(
      doFetch,
      `${baseUrl}/v1/oidc/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      },
      {
        timeoutMs: this.timeoutMs,
        retry: this.retry,
        idempotent: true,
        onRequest: this.config.onRequest,
        onRetry: this.config.onRetry,
      },
    );
    if (!res.ok) throw errorFromResponse(res.status, await res.json().catch(() => null));
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.workloadToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }
}

/** Synchronously reject malformed params before any network work. */
function validateGetTokenParams(params: GetTokenParams): void {
  const fail = (message: string): never => {
    throw new ConnectError('validation_error', message);
  };
  if (typeof params.connector !== 'string' || params.connector.length === 0) {
    fail('connector must be a non-empty string');
  }
  if (params.installationId !== undefined && params.installationId.length === 0) {
    fail('installationId must be a non-empty string when provided');
  }
  if (params.scopes !== undefined) {
    if (!Array.isArray(params.scopes) || params.scopes.some((s) => typeof s !== 'string' || !s)) {
      fail('scopes must be an array of non-empty strings');
    }
  }
  const subject = params.subject;
  if (subject !== undefined) {
    if (subject.type === 'user') {
      if (!subject.userId) fail('subject.userId is required for subject type "user"');
    } else if (subject.type === 'jwt-bearer') {
      if (!subject.assertion) fail('subject.assertion is required for subject type "jwt-bearer"');
    } else if (subject.type !== 'app') {
      fail('subject.type must be one of "app", "user", "jwt-bearer"');
    }
  }
  if (
    params.validityBufferMs !== undefined &&
    (!Number.isFinite(params.validityBufferMs) || params.validityBufferMs < 0)
  ) {
    fail('validityBufferMs must be a non-negative number');
  }
}

function cacheKeyFor(baseUrl: string, params: GetTokenParams): string {
  const subject = params.subject ?? { type: 'app' };
  const subjectKey =
    subject.type === 'app'
      ? 'app'
      : subject.type === 'user'
        ? `user:${subject.userId}`
        : `jwt:${subject.assertion}`;
  return [
    baseUrl,
    params.connector,
    params.installationId ?? '-',
    subjectKey,
    [...(params.scopes ?? [])].sort().join(' '),
    params.resource ?? '',
  ].join('|');
}
