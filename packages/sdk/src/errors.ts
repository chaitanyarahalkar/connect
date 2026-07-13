import type { ApiErrorBody, ErrorCode } from '@connect/shared';

export class ConnectError extends Error {
  constructor(
    public code: ErrorCode | 'network_error',
    message: string,
    public status?: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConnectAuthError extends ConnectError {}
export class LinkNotFoundError extends ConnectError {}
export class EnvironmentNotEnabledError extends ConnectError {}
export class InstallationRequiredError extends ConnectError {}
export class UserAuthorizationRequiredError extends ConnectError {}
export class GrantExpiredError extends ConnectError {}
export class ProviderError extends ConnectError {}

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
