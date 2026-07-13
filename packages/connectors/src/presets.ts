import type { OAuthConfig } from '@connect/shared';

export interface ConnectorPreset {
  key: string;
  name: string;
  type: 'oauth2' | 'github' | 'slack';
  oauthConfig: Omit<OAuthConfig, 'scopesDefault'> & { scopesDefault: string[] };
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
];

export function presetFor(key: string): ConnectorPreset | undefined {
  return PRESETS.find((p) => p.key === key);
}
