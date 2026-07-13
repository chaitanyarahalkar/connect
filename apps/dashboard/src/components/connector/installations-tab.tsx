'use client';

import { useState, type FormEvent } from 'react';
import { apiFetch } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { formatDate } from '@/lib/utils';
import { INSTALLATION_BADGE } from '@/lib/labels';
import type { Connector, Installation } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
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
import { useToast } from '@/components/toast';

export function InstallationsTab({ connector }: { connector: Connector }) {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi<{ installations: Installation[] }>(
    `/v1/connectors/${connector.id}/installations`,
  );

  const [connecting, setConnecting] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [extAccountId, setExtAccountId] = useState('');
  const [extAccountName, setExtAccountName] = useState('');
  const [registerPending, setRegisterPending] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Installation | null>(null);

  const connectAccount = async () => {
    setConnecting(true);
    try {
      const res = await apiFetch<{ url: string }>(`/v1/connectors/${connector.id}/authorize`, {
        method: 'POST',
        body: {},
      });
      window.open(res.url, '_blank', 'noopener');
      toast('Authorization started in a new tab. Refresh after granting consent.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setConnecting(false);
    }
  };

  const registerInstallation = async (e: FormEvent) => {
    e.preventDefault();
    setRegisterPending(true);
    setRegisterError(null);
    try {
      await apiFetch(`/v1/connectors/${connector.id}/installations`, {
        method: 'POST',
        body: {
          externalAccountId: extAccountId,
          ...(extAccountName ? { externalAccountName: extAccountName } : {}),
        },
      });
      setRegisterOpen(false);
      setExtAccountId('');
      setExtAccountName('');
      toast('Installation registered');
      refetch();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegisterPending(false);
    }
  };

  const revoke = async (installation: Installation) => {
    try {
      await apiFetch(`/v1/connectors/${connector.id}/installations/${installation.id}/revoke`, {
        method: 'POST',
        body: {},
      });
      toast('Installation revoked');
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  };

  const installations = data?.installations ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Accounts that have authorized this connector.
        </p>
        <div className="flex gap-2">
          {connector.type === 'github' ? (
            <Button variant="outline" size="sm" onClick={() => setRegisterOpen(true)}>
              Register installation
            </Button>
          ) : null}
          {connector.type !== 'api_key' ? (
            <Button size="sm" loading={connecting} onClick={() => void connectAccount()}>
              Connect account
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorText error={error} onRetry={refetch} />
      ) : loading ? (
        <Spinner label="Loading installations…" />
      ) : installations.length === 0 ? (
        <EmptyState
          title="No installations yet"
          description={
            connector.type === 'api_key'
              ? 'API-key connectors mint tokens without per-account installations.'
              : 'Connect an account to authorize this connector against the provider.'
          }
          action={
            connector.type !== 'api_key' ? (
              <Button loading={connecting} onClick={() => void connectAccount()}>
                Connect account
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>External ID</TableHead>
              <TableHead>Subject user</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {installations.map((inst) => (
              <TableRow key={inst.id}>
                <TableCell className="font-medium text-zinc-900">
                  {inst.externalAccountName ?? '—'}
                </TableCell>
                <TableCell className="font-mono text-xs">{inst.externalAccountId}</TableCell>
                <TableCell className="font-mono text-xs">{inst.subjectUserId ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={INSTALLATION_BADGE[inst.status]}>{inst.status}</Badge>
                </TableCell>
                <TableCell>{formatDate(inst.createdAt)}</TableCell>
                <TableCell className="text-right">
                  {inst.status !== 'revoked' ? (
                    <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(inst)}>
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
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        title="Register GitHub installation"
        description="Manually register a GitHub App installation by its account ID."
      >
        <form onSubmit={(e) => void registerInstallation(e)} className="space-y-4">
          <div>
            <Label htmlFor="ext-id">External account ID</Label>
            <Input
              id="ext-id"
              required
              value={extAccountId}
              onChange={(e) => setExtAccountId(e.target.value)}
              placeholder="12345678"
            />
          </div>
          <div>
            <Label htmlFor="ext-name">Account name (optional)</Label>
            <Input
              id="ext-name"
              value={extAccountName}
              onChange={(e) => setExtAccountName(e.target.value)}
              placeholder="acme-org"
            />
          </div>
          {registerError ? <p className="text-sm text-red-700">{registerError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRegisterOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={registerPending}>
              Register
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (revokeTarget) await revoke(revokeTarget);
        }}
        title="Revoke installation"
        description={`Revoke access for "${revokeTarget?.externalAccountName ?? revokeTarget?.externalAccountId ?? ''}"? Tokens minted from this installation will stop working.`}
        confirmLabel="Revoke"
      />
    </div>
  );
}
