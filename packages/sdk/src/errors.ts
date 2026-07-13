import type { ApiErrorBody, ErrorCode } from '@connect/shared';

/**
 * Every error code a {@link ConnectError} can carry: the server-defined
 * `ErrorCode` union plus two client-side codes (`network_error` when all
 * retry attempts fail to reach the server, `timeout` when a single attempt
 * exceeds the configured timeout).
 */
export type ConnectErrorCode = ErrorCode | 'network_error' | 'timeout';

/**
 * Base class for every error thrown by the SDK.
 *
 * Carries the machine-readable `code`, the HTTP `status` when the error came
 * from an API response, and optional structured `details` from the server.
 */
export class ConnectError extends Error {
  constructor(
    public code: ConnectErrorCode,
    message: string,
    public status?: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown on `unauthorized` / `forbidden` responses — bad or missing Connect credentials. */
export class ConnectAuthError extends ConnectError {}
/** Thrown when the connector is not linked to the calling project (`link_not_found`). */
export class LinkNotFoundError extends ConnectError {}
/** Thrown when the project link does not enable the caller's environment (`environment_not_enabled`). */
export class EnvironmentNotEnabledError extends ConnectError {}
/** Thrown when an installation is required, ambiguous, or revoked — re-run the install flow. */
export class InstallationRequiredError extends ConnectError {}
/** Thrown when the subject user has not authorized the connector yet (`user_authorization_required`). */
export class UserAuthorizationRequiredError extends ConnectError {}
/** Thrown when the underlying provider grant has expired and must be re-authorized (`grant_expired`). */
export class GrantExpiredError extends ConnectError {}
/** Thrown when the upstream provider rejected the request (`provider_error`). */
export class ProviderError extends ConnectError {}

/**
 * Map an API error response to the matching typed {@link ConnectError} subclass.
 * Unknown or missing bodies fall back to a plain `ConnectError` with
 * `internal_error`.
 */
export function errorFromResponse(status: number, body: unknown): ConnectError {
  const err = (body as ApiErrorBody | null)?.error;
  const code = (err?.code ?? 'internal_error') as ErrorCode;
  const message = err?.message ?? `request failed with status ${status}`;
  const details = err?.details;
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
      return new ConnectAuthError(code, message, status, details);
    case 'link_not_found':
      return new LinkNotFoundError(code, message, status, details);
    case 'environment_not_enabled':
      return new EnvironmentNotEnabledError(code, message, status, details);
    case 'installation_required':
    case 'installation_ambiguous':
    case 'installation_revoked':
      return new InstallationRequiredError(code, message, status, details);
    case 'user_authorization_required':
      return new UserAuthorizationRequiredError(code, message, status, details);
    case 'grant_expired':
      return new GrantExpiredError(code, message, status, details);
    case 'provider_error':
      return new ProviderError(code, message, status, details);
    default:
      return new ConnectError(code, message, status, details);
  }
}
