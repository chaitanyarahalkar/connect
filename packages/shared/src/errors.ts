export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_error',
  'conflict',
  'rate_limited',
  'internal_error',
  // token lifecycle
  'link_not_found',
  'environment_not_enabled',
  'installation_required',
  'installation_ambiguous',
  'installation_revoked',
  'user_authorization_required',
  'grant_expired',
  'provider_error',
  'connector_disabled',
  'unsupported_subject',
  // token policy
  'scope_not_allowed',
  'subject_not_allowed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 400,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
  link_not_found: 403,
  environment_not_enabled: 403,
  installation_required: 409,
  installation_ambiguous: 409,
  installation_revoked: 409,
  user_authorization_required: 409,
  grant_expired: 409,
  provider_error: 502,
  connector_disabled: 409,
  unsupported_subject: 400,
  scope_not_allowed: 403,
  subject_not_allowed: 403,
};

/** Thrown by API business logic; converted to an HTTP response by the error middleware. */
export class ConnectError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConnectError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
