import type { OAuthConfig } from '@connect/shared';

/** Normalized result of a code exchange or refresh at a provider. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until expiry, if the provider reported one. */
  expiresIn?: number;
  scope?: string;
  raw: Record<string, unknown>;
}

export interface ProviderIdentity {
  externalAccountId: string;
  externalAccountName?: string;
}

/**
 * Per-provider deviations from vanilla OAuth 2.0. Presets (Slack, GitHub, …)
 * are just an OAuthConfig plus one of these; the engine stays generic.
 */
export interface ProviderQuirks {
  /** Whether a refresh response rotates the refresh token (Slack: always). */
  refreshRotates: boolean;
  /** Applied when the provider omits expires_in (GitHub PATs never expire). */
  defaultExpirySeconds?: number;
  /** Extra query params for the authorization URL (e.g. Slack's user_scope). */
  authorizeExtraParams?: (scopes: string[]) => Record<string, string>;
  /**
   * Parses the token endpoint's response body. Must throw on provider-level
   * errors (Slack returns HTTP 200 with ok:false).
   */
  parseTokenResponse?: (raw: Record<string, unknown>) => TokenSet;
  /** Resolves who the grant belongs to, to label the installation. */
  identify?: (
    tokenSet: TokenSet,
    cfg: OAuthConfig,
    fetchImpl: typeof fetch,
  ) => Promise<ProviderIdentity>;
}
