'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { CopyButton } from '@/components/copy-button';
import { EmptyState, ErrorText, Spinner } from '@/components/feedback';
import { SecretReveal } from '@/components/secret-reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { apiFetch } from '@/lib/api';
import type { Connector, Installation, TokenResponse } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function useCountdown(expiresAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return '';
  const remaining = Math.floor((new Date(expiresAt).getTime() - now) / 1000);
  if (remaining <= 0) return 'expired';
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (h > 0) return `expires in ${h}h ${m}m ${s}s`;
  if (m > 0) return `expires in ${m}m ${s}s`;
  return `expires in ${s}s`;
}

export default function PlaygroundPage() {
  const connectors = useApi<{ connectors: Connector[] }>('/v1/connectors');

  const [connectorId, setConnectorId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [subjectType, setSubjectType] = useState<'app' | 'user'>('app');
  const [userId, setUserId] = useState('');
  const [scopes, setScopes] = useState('');

  const installations = useApi<{ installations: Installation[] }>(
    connectorId ? `/v1/connectors/${connectorId}/installations` : null,
  );

  const [result, setResult] = useState<TokenResponse | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedConnector = useMemo(
    () => connectors.data?.connectors.find((c) => c.id === connectorId) ?? null,
    [connectors.data, connectorId],
  );

  const countdown = useCountdown(result?.expiresAt ?? null);

  const mint = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedConnector) {
      setError('Choose a connector');
      return;
    }
    if (subjectType === 'user' && !userId.trim()) {
      setError('Enter a user ID for a user subject');
      return;
    }
    setMinting(true);
    setError(null);
    setResult(null);
    try {
      const scopeList = scopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await apiFetch<TokenResponse>('/v1/tokens', {
        method: 'POST',
        body: {
          connector: selectedConnector.slug,
          ...(installationId ? { installationId } : {}),
          subject:
            subjectType === 'app' ? { type: 'app' } : { type: 'user', userId: userId.trim() },
          ...(scopeList.length > 0 ? { scopes: scopeList } : {}),
        },
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMinting(false);
    }
  };

  const sdkSnippet = `import { getToken } from '@connect/sdk';\nconst { token } = await getToken({ connector: '${selectedConnector?.slug ?? 'my-connector'}' });`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
        <p className="text-sm text-zinc-500">
          Mint a token as the dashboard user to test a connector end to end.
        </p>
      </div>

      {connectors.error ? (
        <ErrorText error={connectors.error} onRetry={connectors.refetch} />
      ) : connectors.loading ? (
        <Spinner label="Loading connectors…" />
      ) : (connectors.data?.connectors.length ?? 0) === 0 ? (
        <EmptyState
          title="No connectors to test"
          description="Create a connector first, then come back to mint tokens."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Request</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void mint(e)} className="space-y-4">
                <div>
                  <Label htmlFor="pg-connector">Connector</Label>
                  <Select
                    id="pg-connector"
                    value={connectorId}
                    onChange={(e) => {
                      setConnectorId(e.target.value);
                      setInstallationId('');
                    }}
                  >
                    <option value="">Choose a connector…</option>
                    {connectors.data?.connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.slug})
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <Label htmlFor="pg-installation">Installation (optional)</Label>
                  <Select
                    id="pg-installation"
                    value={installationId}
                    onChange={(e) => setInstallationId(e.target.value)}
                    disabled={!connectorId || installations.loading}
                  >
                    <option value="">
                      {installations.loading ? 'Loading installations…' : 'Default'}
                    </option>
                    {(installations.data?.installations ?? [])
                      .filter((i) => i.status === 'active')
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.externalAccountName ?? i.externalAccountId}
                        </option>
                      ))}
                  </Select>
                  {installations.error ? (
                    <p className="mt-1 text-xs text-red-700">{installations.error.message}</p>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="pg-subject">Subject</Label>
                    <Select
                      id="pg-subject"
                      value={subjectType}
                      onChange={(e) => setSubjectType(e.target.value as 'app' | 'user')}
                    >
                      <option value="app">App</option>
                      <option value="user">User</option>
                    </Select>
                  </div>
                  {subjectType === 'user' ? (
                    <div>
                      <Label htmlFor="pg-user">User ID</Label>
                      <Input
                        id="pg-user"
                        value={userId}
                        onChange={(e) => setUserId(e.target.value)}
                        placeholder="user_123"
                      />
                    </div>
                  ) : null}
                </div>

                <div>
                  <Label htmlFor="pg-scopes">Scopes (comma separated, optional)</Label>
                  <Input
                    id="pg-scopes"
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                    placeholder="repo, read:user"
                  />
                </div>

                {error ? <p className="text-sm text-red-700">{error}</p> : null}
                <Button type="submit" loading={minting}>
                  Mint token
                </Button>
              </form>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Result</CardTitle>
                {result ? (
                  <CardDescription className="flex items-center gap-2">
                    <span>{countdown}</span>
                    {result.cached ? (
                      <Badge variant="warning">cached</Badge>
                    ) : (
                      <Badge variant="success">fresh</Badge>
                    )}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                {result ? (
                  <div className="space-y-3">
                    <SecretReveal value={result.token} />
                    <dl className="space-y-1.5 text-sm">
                      <ResultRow label="Type" value={result.tokenType} />
                      <ResultRow
                        label="Scopes"
                        value={result.scopes.length > 0 ? result.scopes.join(', ') : '(none)'}
                      />
                      <ResultRow label="Connector" value={result.connectorId} mono />
                      <ResultRow
                        label="Installation"
                        value={result.installationId ?? '(default)'}
                        mono
                      />
                      <ResultRow
                        label="Expires"
                        value={new Date(result.expiresAt).toLocaleString()}
                      />
                    </dl>
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-zinc-500">
                    Mint a token to see the result here.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>SDK snippet</CardTitle>
                <CopyButton value={sdkSnippet} />
              </CardHeader>
              <CardContent>
                <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-100">
                  {sdkSnippet}
                </pre>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd
        className={`min-w-0 break-all text-zinc-900 ${mono ? 'font-mono text-xs leading-5' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
