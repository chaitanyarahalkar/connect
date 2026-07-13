import type { OAuthConfig, SnowflakeConfig } from '@connect/shared';

export interface ConnectorPreset {
  key: string;
  name: string;
  type: 'oauth2' | 'github' | 'slack' | 'snowflake';
  /** Present on OAuth-based presets. */
  oauthConfig?: Omit<OAuthConfig, 'scopesDefault'> & { scopesDefault: string[] };
  /** Present on non-OAuth presets (snowflake). Values the operator must fill. */
  providerConfigTemplate?: Partial<SnowflakeConfig>;
  docsUrl?: string;
}

/** Prefilled configs the dashboard wizard offers. All ride the generic engine. */
export const PRESETS: ConnectorPreset[] = [
  {
    key: 'github',
    name: 'GitHub',
    type: 'github',
    docsUrl: 'https://docs.github.com/en/apps/oauth-apps',
    oauthConfig: {
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      scopesDefault: ['repo', 'read:user'],
      pkce: false, // GitHub OAuth apps don't support PKCE for confidential clients
      tokenEndpointAuth: 'post',
      quirksKey: 'github',
    },
  },
  {
    key: 'slack',
    name: 'Slack',
    type: 'slack',
    docsUrl: 'https://api.slack.com/authentication/oauth-v2',
    oauthConfig: {
      authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
      revocationEndpoint: 'https://slack.com/api/auth.revoke',
      scopesDefault: ['chat:write'],
      pkce: false,
      tokenEndpointAuth: 'post',
      quirksKey: 'slack',
    },
  },
  {
    key: 'google',
    name: 'Google',
    type: 'oauth2',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2/web-server',
    oauthConfig: {
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
      userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      issuer: 'https://accounts.google.com',
      scopesDefault: ['openid', 'email', 'profile'],
      pkce: true,
      tokenEndpointAuth: 'post',
      quirksKey: 'google',
    },
  },
  {
    key: 'salesforce',
    name: 'Salesforce',
    type: 'oauth2',
    docsUrl:
      'https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm',
    oauthConfig: {
      authorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
      tokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
      revocationEndpoint: 'https://login.salesforce.com/services/oauth2/revoke',
      scopesDefault: ['api', 'refresh_token'],
      pkce: true,
      tokenEndpointAuth: 'post',
      quirksKey: 'salesforce',
    },
  },
  {
    key: 'snowflake',
    name: 'Snowflake',
    type: 'snowflake',
    docsUrl: 'https://docs.snowflake.com/en/user-guide/key-pair-auth',
    providerConfigTemplate: { tokenTtlSeconds: 3600 },
  },
];

export function presetFor(key: string): ConnectorPreset | undefined {
  return PRESETS.find((p) => p.key === key);
}
