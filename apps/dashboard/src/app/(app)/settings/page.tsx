'use client';

import { useState, type FormEvent } from 'react';
import { useApi } from '@/lib/use-api';
import { apiFetch } from '@/lib/api';
import { formatDate, formatDateTime, relativeTime } from '@/lib/utils';
import type { AccessToken, AuditLog, Member } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Spinner, ErrorText, EmptyState } from '@/components/feedback';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SecretReveal } from '@/components/secret-reveal';
import { useToast } from '@/components/toast';

const TABS = [
  { id: 'tokens', label: 'Access Tokens' },
  { id: 'members', label: 'Members' },
  { id: 'audit', label: 'Audit Log' },
];

export default function SettingsPage() {
  const [tab, setTab] = useState('tokens');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-500">Organization access, membership and audit trail.</p>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <TabPanel active={tab === 'tokens'}>
        <AccessTokensTab />
      </TabPanel>
      <TabPanel active={tab === 'members'}>
        <MembersTab />
      </TabPanel>
      <TabPanel active={tab === 'audit'}>
        <AuditLogTab />
      </TabPanel>
    </div>
  );
}

function AccessTokensTab() {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi<{ tokens: AccessToken[] }>('/v1/access-tokens');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<{ name: string; value: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AccessToken | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch<{ token: { id: string; name: string; plaintext: string } }>(
        '/v1/access-tokens',
        {
          method: 'POST',
          body: {
            name,
            ...(expiresInDays ? { expiresInDays: Number(expiresInDays) } : {}),
          },
        },
      );
      setCreateOpen(false);
      setName('');
      setExpiresInDays('');
      setPlaintext({ name: res.token.name, value: res.token.plaintext });
      refetch();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: AccessToken) => {
    try {
      await apiFetch(`/v1/access-tokens/${token.id}`, { method: 'DELETE' });
      toast('Token revoked');
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  };

  const tokens = data?.tokens ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Personal access tokens for the Connect CLI and API.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          Create token
        </Button>
      </div>

      {error ? (
        <ErrorText error={error} onRetry={refetch} />
      ) : loading ? (
        <Spinner label="Loading tokens…" />
      ) : tokens.length === 0 ? (
        <EmptyState
          title="No access tokens"
          description="Create a token to authenticate the CLI or CI jobs against the Connect API."
          action={<Button onClick={() => setCreateOpen(true)}>Create token</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium text-zinc-900">{token.name}</TableCell>
                <TableCell className="font-mono text-xs">{token.tokenPrefix}…</TableCell>
                <TableCell>{token.expiresAt ? formatDate(token.expiresAt) : 'never'}</TableCell>
                <TableCell>{token.lastUsedAt ? relativeTime(token.lastUsedAt) : 'never'}</TableCell>
                <TableCell>
                  {token.revokedAt ? (
                    <Badge variant="destructive">revoked</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!token.revokedAt ? (
                    <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(token)}>
                      Revoke
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create access token"
        description="The token value is shown only once."
      >
        <form onSubmit={(e) => void create(e)} className="space-y-4">
          <div>
            <Label htmlFor="tok-name">Name</Label>
            <Input
              id="tok-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-deploy"
            />
          </div>
          <div>
            <Label htmlFor="tok-days">Expires in days (optional)</Label>
            <Input
              id="tok-days"
              type="number"
              min={1}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              placeholder="90"
            />
          </div>
          {createError ? <p className="text-sm text-red-700">{createError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={creating}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={plaintext !== null}
        onClose={() => setPlaintext(null)}
        title={`Token "${plaintext?.name ?? ''}" created`}
        description="Copy it now — this is the only time it is displayed."
      >
        {plaintext ? (
          <div className="space-y-4">
            <SecretReveal value={plaintext.value} />
            <div className="flex justify-end">
              <Button onClick={() => setPlaintext(null)}>Done</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (revokeTarget) await revoke(revokeTarget);
        }}
        title="Revoke token"
        description={`Revoke "${revokeTarget?.name ?? ''}"? Anything using it will immediately lose access.`}
        confirmLabel="Revoke"
      />
    </div>
  );
}

function MembersTab() {
  const { data, loading, error, refetch } = useApi<{ members: Member[] }>('/v1/members');
  const members = data?.members ?? [];

  if (error) return <ErrorText error={error} onRetry={refetch} />;
  if (loading) return <Spinner label="Loading members…" />;
  if (members.length === 0) {
    return <EmptyState title="No members" description="This organization has no members yet." />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.userId}>
            <TableCell className="font-medium text-zinc-900">{member.name ?? '—'}</TableCell>
            <TableCell>{member.email}</TableCell>
            <TableCell>
              <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
                {member.role}
              </Badge>
            </TableCell>
            <TableCell>{formatDate(member.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AuditLogTab() {
  const { data, loading, error, refetch } = useApi<{ logs: AuditLog[] }>('/v1/audit-logs?limit=100');
  const logs = data?.logs ?? [];

  if (error) return <ErrorText error={error} onRetry={refetch} />;
  if (loading) return <Spinner label="Loading audit log…" />;
  if (logs.length === 0) {
    return (
      <EmptyState
        title="No audit events"
        description="Actions like creating connectors and minting tokens will appear here."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Action</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => (
          <TableRow key={log.id}>
            <TableCell>
              <code className="font-mono text-xs text-zinc-900">{log.action}</code>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {log.actorType}
              {log.actorId ? `:${log.actorId}` : ''}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {log.targetType ? `${log.targetType}:${log.targetId ?? ''}` : '—'}
            </TableCell>
            <TableCell title={formatDateTime(log.createdAt)}>{relativeTime(log.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
