'use client';

import { API_URL } from '@/lib/api';
import type { Connector } from '@/lib/types';
import { formatDateTime } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CopyField } from '@/components/copy-button';

export function ConnectorOverviewTab({ connector }: { connector: Connector }) {
  const callbackUrl = `${API_URL}/v1/oauth/callback`;
  const ingestUrl = `${API_URL}/v1/webhooks/${connector.id}/${connector.ingestKey}`;
  const cfg = connector.oauthConfig;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>
            Configure these URLs in your provider&apos;s app settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-1 text-sm font-medium text-zinc-700">OAuth callback URL</p>
            <CopyField value={callbackUrl} />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-zinc-700">Webhook ingest URL</p>
            <CopyField value={ingestUrl} />
            <p className="mt-1 text-xs text-zinc-500">
              Point provider webhooks here; events fan out to your trigger destinations.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <Row label="Slug" value={connector.slug} mono />
            <Row label="Connector ID" value={connector.id} mono />
            <Row label="OAuth client ID" value={connector.clientId ?? '(not set)'} mono />
            {cfg ? (
              <>
                <Row
                  label="Authorization endpoint"
                  value={cfg.authorizationEndpoint ?? '—'}
                  mono
                />
                <Row label="Token endpoint" value={cfg.tokenEndpoint ?? '—'} mono />
                <Row
                  label="Default scopes"
                  value={cfg.scopesDefault?.length ? cfg.scopesDefault.join(', ') : '(none)'}
                  mono
                />
                <Row label="PKCE" value={cfg.pkce === false ? 'disabled' : 'enabled'} />
              </>
            ) : (
              <Row label="OAuth config" value="(none — API key connector)" />
            )}
            <Row label="Created" value={formatDateTime(connector.createdAt)} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-4">
      <dt className="w-44 shrink-0 text-zinc-500">{label}</dt>
      <dd className={`min-w-0 break-all text-zinc-900 ${mono ? 'font-mono text-xs leading-5' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
