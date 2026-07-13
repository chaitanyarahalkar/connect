import type { TokenRequest, TokenResponse } from '@connect/shared';
import { ConnectError, errorFromResponse } from './errors.js';

export * from './errors.js';
export { ConnectClient } from './client.js';

export interface GetTokenParams {
  connector: string;
  installationId?: string;
  subject?: TokenRequest['subject'];
  scopes?: string[];
  resource?: string;
  authorizationDetails?: Record<string, unknown>[];
  /** Treat a cached token as stale this many ms before expiry. Default 30s. */
  validityBufferMs?: number;
}

export interface ConnectOptions {
  /** Base URL of the Connect API. Default: CONNECT_API_URL or http://localhost:4000 */
  baseUrl?: string;
  /** Explicit credential; overrides env resolution. */
  auth?: string;
  fetch?: typeof fetch;
}

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
  refreshing: Promise<ConnectToken> | null;
}

const DEFAULT_VALIDITY_BUFFER_MS = 30_000;
const REFRESH_AHEAD_FRACTION = 0.8;
const MAX_CACHE = 100;

const tokenCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ConnectToken>>();

/** OIDC JWT minted from client credentials, cached until near expiry. */
let workloadToken: { token: string; expiresAt: number } | null = null;

/**
 * Request a short-lived provider token from Connect.
 *
 * Auth resolution order: options.auth → CONNECT_OIDC_TOKEN →
 * CONNECT_CLIENT_ID/CONNECT_CLIENT_SECRET (self-mint) → CONNECT_ACCESS_TOKEN.
 */
export async function getToken(
  params: GetTokenParams,
  options: ConnectOptions = {},
): Promise<ConnectToken> {
  const key = cacheKeyFor(params);
  const buffer = params.validityBufferMs ?? DEFAULT_VALIDITY_BUFFER_MS;
  const entry = tokenCache.get(key);

  if (entry) {
    const now = Date.now();
    const expiresAt = entry.value.expiresAt.getTime();
    if (expiresAt - buffer > now) {
      // refresh-ahead: kick off a background fetch as expiry approaches
      if (shouldRefreshAhead(entry.value, now) && !entry.refreshing) {
        entry.refreshing = fetchToken(params, options)
          .then((fresh) => {
            tokenCache.set(key, { value: fresh, refreshing: null });
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

  // stale or missing: de-dupe concurrent callers
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fetchToken(params, options)
    .then((fresh) => {
      if (tokenCache.size >= MAX_CACHE && !tokenCache.has(key)) {
        const oldest = tokenCache.keys().next().value;
        if (oldest) tokenCache.delete(oldest);
      }
      tokenCache.set(key, { value: fresh, refreshing: null });
      return fresh;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Test hook / logout: drop all cached tokens. */
export function clearTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
  workloadToken = null;
}

function shouldRefreshAhead(token: ConnectToken, now: number): boolean {
  // We only know expiresAt, not issuedAt; approximate refresh-ahead by
  // refreshing once less than (1 - 0.8) = 20% of a nominal 15-min lifetime remains.
  const remaining = token.expiresAt.getTime() - now;
  return remaining < 900_000 * (1 - REFRESH_AHEAD_FRACTION);
}

function cacheKeyFor(params: GetTokenParams): string {
  const subject = params.subject ?? { type: 'app' };
  const subjectKey =
    subject.type === 'app' ? 'app' : subject.type === 'user' ? `user:${subject.userId}` : 'jwt';
  return [
    params.connector,
    params.installationId ?? '-',
    subjectKey,
    [...(params.scopes ?? [])].sort().join(' '),
    params.resource ?? '',
  ].join('|');
}

async function fetchToken(params: GetTokenParams, options: ConnectOptions): Promise<ConnectToken> {
  const baseUrl = options.baseUrl ?? process.env.CONNECT_API_URL ?? 'http://localhost:4000';
  const doFetch = options.fetch ?? fetch;
  const auth = await resolveAuth(baseUrl, options, doFetch);

  const body: TokenRequest = {
    connector: params.connector,
    installationId: params.installationId,
    subject: params.subject ?? { type: 'app' },
    scopes: params.scopes,
    resource: params.resource,
    authorizationDetails: params.authorizationDetails,
  };

  const res = await requestWithRetry(doFetch, `${baseUrl}/v1/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });

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

async function resolveAuth(
  baseUrl: string,
  options: ConnectOptions,
  doFetch: typeof fetch,
): Promise<string> {
  if (options.auth) return options.auth;
  if (process.env.CONNECT_OIDC_TOKEN) return process.env.CONNECT_OIDC_TOKEN;

  const clientId = process.env.CONNECT_CLIENT_ID;
  const clientSecret = process.env.CONNECT_CLIENT_SECRET;
  if (clientId && clientSecret) {
    if (workloadToken && workloadToken.expiresAt - 30_000 > Date.now()) {
      return workloadToken.token;
    }
    const res = await doFetch(`${baseUrl}/v1/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) throw errorFromResponse(res.status, await res.json().catch(() => null));
    const data = (await res.json()) as { access_token: string; expires_in: number };
    workloadToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  if (process.env.CONNECT_ACCESS_TOKEN) return process.env.CONNECT_ACCESS_TOKEN;
  throw new ConnectError(
    'unauthorized',
    'no Connect credentials found: set CONNECT_OIDC_TOKEN, CONNECT_CLIENT_ID/CONNECT_CLIENT_SECRET, or CONNECT_ACCESS_TOKEN',
  );
}

async function requestWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(url, init);
      if ((res.status >= 500 || res.status === 429) && i < attempts - 1) {
        await backoff(i);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await backoff(i);
    }
  }
  throw new ConnectError('network_error', `request to ${url} failed: ${String(lastError)}`);
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000 * 2 ** attempt, 4000) * (0.5 + Math.random() / 2);
  return new Promise((r) => setTimeout(r, ms));
}
