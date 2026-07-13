import { ERROR_CODES, ERROR_STATUS } from '@connect/shared';
import { describe, expect, it } from 'vitest';
import {
  ConnectAuthError,
  ConnectError,
  EnvironmentNotEnabledError,
  errorFromResponse,
  GrantExpiredError,
  InstallationRequiredError,
  LinkNotFoundError,
  ProviderError,
  UserAuthorizationRequiredError,
} from '../src/errors.js';

const EXPECTED_CLASS: Record<string, new (...args: never[]) => ConnectError> = {
  unauthorized: ConnectAuthError,
  forbidden: ConnectAuthError,
  link_not_found: LinkNotFoundError,
  environment_not_enabled: EnvironmentNotEnabledError,
  installation_required: InstallationRequiredError,
  installation_ambiguous: InstallationRequiredError,
  installation_revoked: InstallationRequiredError,
  user_authorization_required: UserAuthorizationRequiredError,
  grant_expired: GrantExpiredError,
  provider_error: ProviderError,
};

describe('errorFromResponse', () => {
  it.each(ERROR_CODES)('maps %s to its typed subclass', (code) => {
    const status = ERROR_STATUS[code];
    const err = errorFromResponse(status, {
      error: { code, message: 'msg', details: { a: 1 } },
    });
    expect(err).toBeInstanceOf(EXPECTED_CLASS[code] ?? ConnectError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe('msg');
    expect(err.details).toEqual({ a: 1 });
    expect(err.name).toBe((EXPECTED_CLASS[code] ?? ConnectError).name);
  });

  it('falls back to internal_error for null or malformed bodies', () => {
    const err = errorFromResponse(502, null);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.code).toBe('internal_error');
    expect(err.status).toBe(502);
    expect(err.message).toContain('502');
  });
});
