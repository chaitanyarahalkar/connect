'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { apiFetch } from '@/lib/api';
import { TYPE_LABELS } from '@/lib/labels';
import type { Connector, ConnectorType } from '@/lib/types';
import { cn, slugify } from '@/lib/utils';

interface EndpointState {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuer: string;
  scopesDefault: string;
  pkce: boolean;
  tokenEndpointAuth: 'basic' | 'post';
  quirksKey: string;
}

interface SecretState {
  oauthClientId: string;
  oauthClientSecret: string;
  apiKey: string;
  webhookSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  slackSigningSecret: string;
  snowflakePrivateKey: string;
}

interface SnowflakeState {
  account: string;
  username: string;
  tokenTtlSeconds: string;
}

const EMPTY_ENDPOINTS: EndpointState = {
  authorizationEndpoint: '',
  tokenEndpoint: '',
  issuer: '',
  scopesDefault: '',
  pkce: true,
  tokenEndpointAuth: 'post',
  quirksKey: '',
};

const EMPTY_SECRETS: SecretState = {
  oauthClientId: '',
  oauthClientSecret: '',
  apiKey: '',
  webhookSecret: '',
  githubAppId: '',
  githubAppPrivateKey: '',
  slackSigningSecret: '',
  snowflakePrivateKey: '',
};

const EMPTY_SNOWFLAKE: SnowflakeState = { account: '', username: '', tokenTtlSeconds: '3600' };

interface PresetChoice {
  key: string;
  type: ConnectorType;
  title: string;
  description: string;
  /** Prefilled endpoint config for OAuth-based presets. */
  endpoints?: Partial<EndpointState>;
  /** Prefill the name/slug when picked. */
  prefillName?: boolean;
}

const TYPE_CHOICES: PresetChoice[] = [
  {
    key: 'api_key',
    type: 'api_key',
    title: 'API Key',
    description: 'Store a static API key and hand it to workloads on demand.',
  },
  {
    key: 'oauth2',
    type: 'oauth2',
    title: 'Custom OAuth',
    description: 'Any OAuth 2.0 / OIDC provider. Discover endpoints from an issuer URL.',
  },
  {
    key: 'github',
    type: 'github',
    title: 'GitHub',
    description: 'GitHub App / OAuth with installation tokens. Endpoints prefilled.',
    prefillName: true,
    endpoints: {
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      pkce: false,
      quirksKey: 'github',
    },
  },
  {
    key: 'slack',
    type: 'slack',
    title: 'Slack',
    description: 'Slack app OAuth with bot tokens. Endpoints prefilled.',
    prefillName: true,
    endpoints: {
      authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
      pkce: false,
      quirksKey: 'slack',
    },
  },
  {
    key: 'google',
    type: 'oauth2',
    title: 'Google',
    description: 'Google OAuth with offline refresh tokens. Endpoints prefilled.',
    prefillName: true,
    endpoints: {
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      issuer: 'https://accounts.google.com',
      scopesDefault: 'openid, email, profile',
      pkce: true,
      quirksKey: 'google',
    },
  },
  {
    key: 'salesforce',
    type: 'oauth2',
    title: 'Salesforce',
    description: 'Salesforce connected app OAuth. Endpoints prefilled.',
    prefillName: true,
    endpoints: {
      authorizationEndpoint: 'https://login.salesforce.com/services/oauth2/authorize',
      tokenEndpoint: 'https://login.salesforce.com/services/oauth2/token',
      scopesDefault: 'api, refresh_token',
      pkce: true,
      quirksKey: 'salesforce',
    },
  },
  {
    key: 'snowflake',
    type: 'snowflake',
    title: 'Snowflake',
    description: 'Key-pair auth: Connect signs short-lived KEYPAIR_JWTs locally.',
    prefillName: true,
  },
];

export default function NewConnectorPage() {
  const router = useRouter();
  const { toast } = useToast();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [type, setType] = useState<ConnectorType | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [color, setColor] = useState('');
  const [endpoints, setEndpoints] = useState<EndpointState>(EMPTY_ENDPOINTS);
  const [snowflake, setSnowflake] = useState<SnowflakeState>(EMPTY_SNOWFLAKE);
  const [secrets, setSecrets] = useState<SecretState>(EMPTY_SECRETS);
  const [issuerInput, setIssuerInput] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const isOauthLike = type === 'oauth2' || type === 'github' || type === 'slack';

  const chooseType = (choice: PresetChoice) => {
    setPresetKey(choice.key);
    setType(choice.type);
    setEndpoints({ ...EMPTY_ENDPOINTS, ...choice.endpoints });
    if (!name && choice.prefillName) {
      setName(choice.title);
      if (!slugTouched) setSlug(slugify(choice.title));
    }
    setError(null);
    setStep(2);
  };

  const discover = async () => {
    if (!issuerInput) return;
    setDiscovering(true);
    setError(null);
    try {
      const res = await apiFetch<{
        config: {
          authorizationEndpoint?: string;
          tokenEndpoint?: string;
          issuer?: string;
        };
      }>('/v1/connectors/discover', { method: 'POST', body: { issuer: issuerInput } });
      setEndpoints((prev) => ({
        ...prev,
        authorizationEndpoint: res.config.authorizationEndpoint ?? prev.authorizationEndpoint,
        tokenEndpoint: res.config.tokenEndpoint ?? prev.tokenEndpoint,
        issuer: res.config.issuer ?? issuerInput,
      }));
      toast('Endpoints discovered from issuer');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const validateStep2 = (): string | null => {
    if (!name.trim()) return 'Name is required';
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
      return 'Slug must be lowercase letters, digits and hyphens (min 2 chars)';
    }
    if (isOauthLike && (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint)) {
      return 'Authorization and token endpoints are required';
    }
    if (type === 'snowflake' && (!snowflake.account.trim() || !snowflake.username.trim())) {
      return 'Snowflake account and username are required';
    }
    return null;
  };

  const buildPayload = () => {
    if (!type) return null;
    const secretEntries = Object.entries(secrets).filter(([, v]) => v.trim() !== '');
    const payload: Record<string, unknown> = {
      slug,
      name: name.trim(),
      type,
    };
    if (color) payload.branding = { color };
    if (isOauthLike) {
      payload.oauthConfig = {
        authorizationEndpoint: endpoints.authorizationEndpoint,
        tokenEndpoint: endpoints.tokenEndpoint,
        ...(endpoints.issuer ? { issuer: endpoints.issuer } : {}),
        scopesDefault: endpoints.scopesDefault
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        pkce: endpoints.pkce,
        tokenEndpointAuth: endpoints.tokenEndpointAuth,
        ...(endpoints.quirksKey ? { quirksKey: endpoints.quirksKey } : {}),
      };
    }
    if (type === 'snowflake') {
      payload.providerConfig = {
        account: snowflake.account.trim(),
        username: snowflake.username.trim(),
        tokenTtlSeconds: Number(snowflake.tokenTtlSeconds || '3600'),
      };
    }
    if (secretEntries.length > 0) {
      payload.secrets = Object.fromEntries(secretEntries);
    }
    return payload;
  };

  const create = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch<{ connector: Connector }>('/v1/connectors', {
        method: 'POST',
        body: payload,
      });
      toast(`Connector "${res.connector.name}" created`);
      router.push(`/connectors/${res.connector.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  const setSecret = (key: keyof SecretState, value: string) =>
    setSecrets((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New connector</h1>
        <p className="text-sm text-zinc-500">Step {step} of 3</p>
      </div>

      <div className="flex gap-2">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className={cn('h-1 flex-1 rounded-full', s <= step ? 'bg-zinc-900' : 'bg-zinc-200')}
          />
        ))}
      </div>

      {step === 1 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TYPE_CHOICES.map((choice) => (
            <button key={choice.key} type="button" onClick={() => chooseType(choice)}>
              <Card
                className={cn(
                  'h-full text-left transition-colors hover:border-zinc-400',
                  presetKey === choice.key && 'border-zinc-900 ring-1 ring-zinc-900',
                )}
              >
                <CardContent className="p-5">
                  <p className="font-medium text-zinc-900">{choice.title}</p>
                  <p className="mt-1 text-sm text-zinc-500">{choice.description}</p>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      ) : null}

      {step === 2 && type ? (
        <Card>
          <CardContent className="space-y-5 p-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="c-name">Name</Label>
                <Input
                  id="c-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                  placeholder="GitHub"
                />
              </div>
              <div>
                <Label htmlFor="c-slug">Slug</Label>
                <Input
                  id="c-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  placeholder="github"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="c-color">Brand color (optional)</Label>
              <Input
                id="c-color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#24292f"
                pattern="#[0-9a-fA-F]{6}"
              />
            </div>

            {type === 'oauth2' ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                <Label htmlFor="c-issuer">Discover from issuer URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="c-issuer"
                    value={issuerInput}
                    onChange={(e) => setIssuerInput(e.target.value)}
                    placeholder="https://accounts.example.com"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void discover()}
                    loading={discovering}
                  >
                    Discover
                  </Button>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Fetches /.well-known/openid-configuration and fills the endpoints below.
                </p>
              </div>
            ) : null}

            {isOauthLike ? (
              <>
                <div>
                  <Label htmlFor="c-authz">Authorization endpoint</Label>
                  <Input
                    id="c-authz"
                    value={endpoints.authorizationEndpoint}
                    onChange={(e) =>
                      setEndpoints((p) => ({ ...p, authorizationEndpoint: e.target.value }))
                    }
                    placeholder="https://provider.com/oauth/authorize"
                  />
                </div>
                <div>
                  <Label htmlFor="c-token">Token endpoint</Label>
                  <Input
                    id="c-token"
                    value={endpoints.tokenEndpoint}
                    onChange={(e) => setEndpoints((p) => ({ ...p, tokenEndpoint: e.target.value }))}
                    placeholder="https://provider.com/oauth/token"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="c-scopes">Default scopes (comma separated)</Label>
                    <Input
                      id="c-scopes"
                      value={endpoints.scopesDefault}
                      onChange={(e) =>
                        setEndpoints((p) => ({ ...p, scopesDefault: e.target.value }))
                      }
                      placeholder="read:user, repo"
                    />
                  </div>
                  <div>
                    <Label htmlFor="c-auth-method">Token endpoint auth</Label>
                    <Select
                      id="c-auth-method"
                      value={endpoints.tokenEndpointAuth}
                      onChange={(e) =>
                        setEndpoints((p) => ({
                          ...p,
                          tokenEndpointAuth: e.target.value as 'basic' | 'post',
                        }))
                      }
                    >
                      <option value="post">POST body</option>
                      <option value="basic">HTTP Basic</option>
                    </Select>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={endpoints.pkce}
                    onChange={(e) => setEndpoints((p) => ({ ...p, pkce: e.target.checked }))}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  Use PKCE
                </label>
              </>
            ) : null}

            {type === 'snowflake' ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="sf-account">Account identifier</Label>
                    <Input
                      id="sf-account"
                      value={snowflake.account}
                      onChange={(e) => setSnowflake((p) => ({ ...p, account: e.target.value }))}
                      placeholder="xy12345 or xy12345.us-east-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="sf-user">Username</Label>
                    <Input
                      id="sf-user"
                      value={snowflake.username}
                      onChange={(e) => setSnowflake((p) => ({ ...p, username: e.target.value }))}
                      placeholder="SVC_ANALYTICS"
                    />
                  </div>
                </div>
                <div className="max-w-xs">
                  <Label htmlFor="sf-ttl">JWT lifetime (seconds, max 3600)</Label>
                  <Input
                    id="sf-ttl"
                    type="number"
                    min={60}
                    max={3600}
                    value={snowflake.tokenTtlSeconds}
                    onChange={(e) =>
                      setSnowflake((p) => ({ ...p, tokenTtlSeconds: e.target.value }))
                    }
                  />
                </div>
              </>
            ) : null}

            <div className="border-t border-zinc-100 pt-4">
              <p className="mb-3 text-sm font-medium text-zinc-900">
                Credentials{' '}
                <span className="font-normal text-zinc-500">
                  (write-only, never displayed again)
                </span>
              </p>
              <div className="space-y-4">
                {isOauthLike ? (
                  <div className="grid grid-cols-2 gap-4">
                    <SecretInput
                      label="OAuth client ID"
                      value={secrets.oauthClientId}
                      onChange={(v) => setSecret('oauthClientId', v)}
                    />
                    <SecretInput
                      label="OAuth client secret"
                      value={secrets.oauthClientSecret}
                      onChange={(v) => setSecret('oauthClientSecret', v)}
                    />
                  </div>
                ) : null}
                {type === 'api_key' ? (
                  <SecretInput
                    label="API key"
                    value={secrets.apiKey}
                    onChange={(v) => setSecret('apiKey', v)}
                  />
                ) : null}
                {type === 'github' ? (
                  <>
                    <SecretInput
                      label="GitHub App ID"
                      value={secrets.githubAppId}
                      onChange={(v) => setSecret('githubAppId', v)}
                      masked={false}
                    />
                    <div>
                      <Label>GitHub App private key (PEM)</Label>
                      <textarea
                        value={secrets.githubAppPrivateKey}
                        onChange={(e) => setSecret('githubAppPrivateKey', e.target.value)}
                        rows={4}
                        placeholder="-----BEGIN RSA PRIVATE KEY-----"
                        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200"
                      />
                    </div>
                  </>
                ) : null}
                {type === 'slack' ? (
                  <SecretInput
                    label="Slack signing secret"
                    value={secrets.slackSigningSecret}
                    onChange={(v) => setSecret('slackSigningSecret', v)}
                  />
                ) : null}
                {type === 'snowflake' ? (
                  <div>
                    <Label>RSA private key (PKCS#8 PEM)</Label>
                    <textarea
                      value={secrets.snowflakePrivateKey}
                      onChange={(e) => setSecret('snowflakePrivateKey', e.target.value)}
                      rows={4}
                      placeholder="-----BEGIN PRIVATE KEY-----"
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200"
                    />
                    <p className="mt-1 text-xs text-zinc-500">
                      The matching public key must be set on the Snowflake user via RSA_PUBLIC_KEY.
                    </p>
                  </div>
                ) : null}
                <SecretInput
                  label="Webhook secret (optional)"
                  value={secrets.webhookSecret}
                  onChange={(v) => setSecret('webhookSecret', v)}
                />
              </div>
            </div>

            {error ? <p className="text-sm text-red-700">{error}</p> : null}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                onClick={() => {
                  const problem = validateStep2();
                  if (problem) {
                    setError(problem);
                    return;
                  }
                  setError(null);
                  setStep(3);
                }}
              >
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 3 && type ? (
        <Card>
          <CardContent className="space-y-4 p-6">
            <p className="text-sm font-medium text-zinc-900">Review</p>
            <dl className="space-y-2 text-sm">
              <ReviewRow label="Type" value={TYPE_LABELS[type]} />
              <ReviewRow label="Name" value={name} />
              <ReviewRow label="Slug" value={slug} mono />
              {color ? <ReviewRow label="Brand color" value={color} mono /> : null}
              {isOauthLike ? (
                <>
                  <ReviewRow label="Authorize" value={endpoints.authorizationEndpoint} mono />
                  <ReviewRow label="Token" value={endpoints.tokenEndpoint} mono />
                  <ReviewRow label="Scopes" value={endpoints.scopesDefault || '(none)'} mono />
                  <ReviewRow label="PKCE" value={endpoints.pkce ? 'yes' : 'no'} />
                </>
              ) : null}
              {type === 'snowflake' ? (
                <>
                  <ReviewRow label="Account" value={snowflake.account} mono />
                  <ReviewRow label="Username" value={snowflake.username} mono />
                  <ReviewRow label="JWT TTL" value={`${snowflake.tokenTtlSeconds}s`} />
                </>
              ) : null}
              <ReviewRow
                label="Secrets"
                value={
                  Object.entries(secrets)
                    .filter(([, v]) => v.trim() !== '')
                    .map(([k]) => k)
                    .join(', ') || '(none — you can add them later in Settings)'
                }
              />
            </dl>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button onClick={() => void create()} loading={creating}>
                Create connector
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  masked = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  masked?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type={masked ? 'password' : 'text'}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-4">
      <dt className="w-32 shrink-0 text-zinc-500">{label}</dt>
      <dd className={cn('min-w-0 break-all text-zinc-900', mono && 'font-mono text-xs leading-5')}>
        {value}
      </dd>
    </div>
  );
}
