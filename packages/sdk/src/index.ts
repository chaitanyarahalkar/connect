/**
 * @connect/sdk — request short-lived provider tokens from Connect.
 *
 * Prefer the {@link Connect} class for isolated configuration and caching;
 * the module-level {@link getToken} delegates to a shared default instance
 * and remains fully supported.
 */
import {
  Connect,
  type ConnectToken,
  type GetTokenOptions,
  type GetTokenParams,
} from './connect.js';

export { ConnectClient, type ConnectClientOptions } from './client.js';
export {
  Connect,
  type ConnectConfig,
  type ConnectOptions,
  type ConnectToken,
  type GetTokenOptions,
  type GetTokenParams,
} from './connect.js';
export * from './errors.js';
export type { RequestEvent, RetryConfig, RetryEvent } from './http.js';

let defaultInstance: Connect | undefined;

/**
 * Request a short-lived provider token from Connect using a shared default
 * client. Equivalent to `new Connect().getToken(params, options)` with one
 * process-wide cache.
 *
 * Auth resolution order: `options.auth` → `CONNECT_OIDC_TOKEN` →
 * `CONNECT_CLIENT_ID`/`CONNECT_CLIENT_SECRET` (self-mint) → `CONNECT_ACCESS_TOKEN`.
 */
export async function getToken(
  params: GetTokenParams,
  options: GetTokenOptions = {},
): Promise<ConnectToken> {
  defaultInstance ??= new Connect();
  return defaultInstance.getToken(params, options);
}

/** Test hook / logout: drop all tokens cached by the default client. */
export function clearTokenCache(): void {
  defaultInstance?.clearCache();
}
