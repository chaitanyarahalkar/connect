'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api';
import type { Connector, TokenPolicy } from '@/lib/types';

interface SecretFields {
  oauthClientId: string;
  oauthClientSecret: string;
  apiKey: string;
  webhookSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  slackSigningSecret: string;
  snowflakePrivateKey: string;
}

const EMPTY: SecretFields = {
  oauthClientId: '',
  oauthClientSecret: '',
  apiKey: '',
  webhookSecret: '',
  githubAppId: '',
  githubAppPrivateKey: '',
  slackSigningSecret: '',
  snowflakePrivateKey: '',
};

export function ConnectorSettingsTab({
  connector,
  onUpdated,
}: {
  connector: Connector;
  onUpdated: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(connector.name);
  const [renaming, setRenaming] = useState(false);

  const [secrets, setSecrets] = useState<SecretFields>(EMPTY);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    setRenaming(true);
    try {
      await apiFetch(`/v1/connectors/${connector.id}`, {
        method: 'PATCH',
        body: { name: name.trim() },
      });
      toast('Connector renamed');
      onUpdated();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setRenaming(false);
    }
  };

  const rotate = async (e: FormEvent) => {
    e.preventDefault();
    const entries = Object.entries(secrets).filter(([, v]) => v.trim() !== '');
    if (entries.length === 0) {
      setRotateError('Fill in at least one secret to rotate');
      return;
    }
    setRotating(true);
    setRotateError(null);
    try {
      await apiFetch(`/v1/connectors/${connector.id}/secrets`, {
        method: 'PUT',
        body: Object.fromEntries(entries),
      });
      setSecrets(EMPTY);
      toast('Secrets rotated');
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(false);
    }
  };

  const remove = async () => {
    try {
      await apiFetch(`/v1/connectors/${connector.id}`, { method: 'DELETE' });
      toast('Connector deleted');
      router.push('/connectors');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  };

  const setSecret = (key: keyof SecretFields, value: string) =>
    setSecrets((prev) => ({ ...prev, [key]: value }));

  const isOauthLike = connector.type !== 'api_key' && connector.type !== 'snowflake';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void rename(e)} className="flex items-end gap-3">
            <div className="max-w-sm flex-1">
              <Label htmlFor="rename">Name</Label>
              <Input id="rename" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" variant="outline" loading={renaming}>
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rotate secrets</CardTitle>
          <CardDescription>
            Secrets are write-only. Leave a field blank to keep its current value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void rotate(e)} className="space-y-4">
            {isOauthLike ? (
              <div className="grid grid-cols-2 gap-4">
                <SecretField
                  label="OAuth client ID"
                  value={secrets.oauthClientId}
                  onChange={(v) => setSecret('oauthClientId', v)}
                />
                <SecretField
                  label="OAuth client secret"
                  value={secrets.oauthClientSecret}
                  onChange={(v) => setSecret('oauthClientSecret', v)}
                />
              </div>
            ) : null}
            {connector.type === 'api_key' ? (
              <SecretField
                label="API key"
                value={secrets.apiKey}
                onChange={(v) => setSecret('apiKey', v)}
              />
            ) : null}
            {connector.type === 'github' ? (
              <>
                <SecretField
                  label="GitHub App ID"
                  value={secrets.githubAppId}
                  onChange={(v) => setSecret('githubAppId', v)}
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
            {connector.type === 'slack' ? (
              <SecretField
                label="Slack signing secret"
                value={secrets.slackSigningSecret}
                onChange={(v) => setSecret('slackSigningSecret', v)}
              />
            ) : null}
            {connector.type === 'snowflake' ? (
              <div>
                <Label>RSA private key (PKCS#8 PEM)</Label>
                <textarea
                  value={secrets.snowflakePrivateKey}
                  onChange={(e) => setSecret('snowflakePrivateKey', e.target.value)}
                  rows={4}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-200"
                />
              </div>
            ) : null}
            <SecretField
              label="Webhook secret"
              value={secrets.webhookSecret}
              onChange={(v) => setSecret('webhookSecret', v)}
            />
            {rotateError ? <p className="text-sm text-red-700">{rotateError}</p> : null}
            <Button type="submit" loading={rotating}>
              Save secrets
            </Button>
          </form>
        </CardContent>
      </Card>

      <TokenPolicyCard connector={connector} onUpdated={onUpdated} />

      <Card className="border-red-200">
        <CardHeader>
          <CardTitle className="text-red-700">Danger zone</CardTitle>
          <CardDescription>
            Deleting a connector revokes its installations and breaks all project links.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete connector
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={remove}
        title="Delete connector"
        description={`Permanently delete "${connector.name}"? This cannot be undone.`}
      />
    </div>
  );
}

const SUBJECT_TYPES = ['app', 'user', 'jwt-bearer'] as const;

function TokenPolicyCard({
  connector,
  onUpdated,
}: {
  connector: Connector;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const policy = connector.tokenPolicy ?? {};

  const [maxTtl, setMaxTtl] = useState(policy.maxTtlSeconds ? String(policy.maxTtlSeconds) : '');
  const [scopes, setScopes] = useState(policy.allowedScopes?.join(', ') ?? '');
  const [subjects, setSubjects] = useState<string[]>(policy.allowedSubjects ?? []);
  const [rateLimit, setRateLimit] = useState(
    policy.rateLimit ? String(policy.rateLimit.limit) : '',
  );
  const [rateWindow, setRateWindow] = useState(
    policy.rateLimit ? String(policy.rateLimit.windowSeconds) : '60',
  );
  const [saving, setSaving] = useState(false);

  const toggleSubject = (s: string) =>
    setSubjects((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const scopeList = scopes
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next: TokenPolicy = {
      ...(maxTtl ? { maxTtlSeconds: Number(maxTtl) } : {}),
      ...(scopeList.length ? { allowedScopes: scopeList } : {}),
      ...(subjects.length
        ? { allowedSubjects: subjects as NonNullable<TokenPolicy['allowedSubjects']> }
        : {}),
      ...(rateLimit
        ? { rateLimit: { limit: Number(rateLimit), windowSeconds: Number(rateWindow || '60') } }
        : {}),
    };
    setSaving(true);
    try {
      await apiFetch(`/v1/connectors/${connector.id}`, {
        method: 'PATCH',
        body: { tokenPolicy: Object.keys(next).length ? next : null },
      });
      toast('Token policy saved');
      onUpdated();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token policy</CardTitle>
        <CardDescription>
          Limits enforced on every token request: lifetime cap, scope/subject allow-lists, and a
          per-installation rate limit. Leave fields empty for no restriction.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label htmlFor="policy-ttl">Max token TTL (seconds)</Label>
              <Input
                id="policy-ttl"
                type="number"
                min={30}
                placeholder="unlimited"
                value={maxTtl}
                onChange={(e) => setMaxTtl(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="policy-rate">Rate limit (requests)</Label>
              <Input
                id="policy-rate"
                type="number"
                min={1}
                placeholder="unlimited"
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="policy-window">…per window (seconds)</Label>
              <Input
                id="policy-window"
                type="number"
                min={1}
                max={3600}
                value={rateWindow}
                disabled={!rateLimit}
                onChange={(e) => setRateWindow(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="policy-scopes">Allowed scopes (comma-separated)</Label>
            <Input
              id="policy-scopes"
              placeholder="any scope"
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
            />
          </div>
          <div>
            <Label>Allowed subjects</Label>
            <div className="flex gap-4 pt-1">
              {SUBJECT_TYPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={subjects.includes(s)}
                    onChange={() => toggleSubject(s)}
                  />
                  {s}
                </label>
              ))}
              <span className="text-xs text-zinc-500 self-center">
                (none checked = all allowed)
              </span>
            </div>
          </div>
          <Button type="submit" loading={saving}>
            Save policy
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="password"
        autoComplete="new-password"
        placeholder="••••••••  (unchanged)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
