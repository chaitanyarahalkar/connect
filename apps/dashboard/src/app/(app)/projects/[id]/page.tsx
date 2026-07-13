'use client';

import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { EmptyState, ErrorText, Spinner } from '@/components/feedback';
import { useToast } from '@/components/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch, PUBLIC_API_URL } from '@/lib/api';
import type {
  Connector,
  CreatedProjectClient,
  Environment,
  Project,
  ProjectClient,
  ProjectLink,
} from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { formatDate } from '@/lib/utils';

const ENVIRONMENTS: Environment[] = ['production', 'preview', 'development'];

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { toast } = useToast();

  const project = useApi<{ project: Project }>(`/v1/projects/${id}`);
  const links = useApi<{ links: ProjectLink[] }>(`/v1/links?project=${id}`);
  const connectors = useApi<{ connectors: Connector[] }>('/v1/connectors');
  const clients = useApi<{ clients: ProjectClient[] }>(`/v1/projects/${id}/clients`);

  const [createOpen, setCreateOpen] = useState(false);
  const [environment, setEnvironment] = useState<Environment>('development');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedProjectClient | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectClient | null>(null);

  const connectorById = useMemo(() => {
    const map = new Map<string, Connector>();
    for (const c of connectors.data?.connectors ?? []) map.set(c.id, c);
    return map;
  }, [connectors.data]);

  const createClient = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch<{ client: CreatedProjectClient }>(`/v1/projects/${id}/clients`, {
        method: 'POST',
        body: { environment },
      });
      setCreateOpen(false);
      setCreated(res.client);
      clients.refetch();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const deleteClient = async (client: ProjectClient) => {
    try {
      await apiFetch(`/v1/projects/${id}/clients/${client.clientId}`, { method: 'DELETE' });
      toast('Client deleted');
      clients.refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  };

  if (project.loading) return <Spinner label="Loading project…" />;
  if (project.error) return <ErrorText error={project.error} onRetry={project.refetch} />;
  const proj = project.data?.project;
  if (!proj) return null;

  const envSnippet = created
    ? [
        `CONNECT_API_URL=${PUBLIC_API_URL}`,
        `CONNECT_CLIENT_ID=${created.clientId}`,
        `CONNECT_CLIENT_SECRET=${created.clientSecret}`,
      ].join('\n')
    : '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{proj.name}</h1>
        <p className="font-mono text-sm text-zinc-500">{proj.slug}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Linked connectors</CardTitle>
          <CardDescription>
            Connectors this project&apos;s workloads can request tokens for.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {links.error ? (
            <ErrorText error={links.error} onRetry={links.refetch} />
          ) : links.loading || connectors.loading ? (
            <Spinner label="Loading links…" />
          ) : (links.data?.links.length ?? 0) === 0 ? (
            <EmptyState
              title="No connectors linked"
              description="Open a connector's Links tab to attach it to this project."
              action={
                <Link href="/connectors">
                  <Button variant="outline">Browse connectors</Button>
                </Link>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connector</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Environments</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.data?.links.map((link) => {
                  const connector = connectorById.get(link.connectorId);
                  return (
                    <TableRow key={link.id}>
                      <TableCell>
                        <Link
                          href={`/connectors/${link.connectorId}`}
                          className="font-medium text-zinc-900 underline-offset-2 hover:underline"
                        >
                          {connector?.name ?? link.connectorId}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{connector?.type ?? '—'}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {link.environments.map((env) => (
                            <Badge key={env}>{env}</Badge>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Workload identity</CardTitle>
            <CardDescription>
              OAuth clients your app uses to authenticate to Connect per environment.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Create client
          </Button>
        </CardHeader>
        <CardContent>
          {clients.error ? (
            <ErrorText error={clients.error} onRetry={clients.refetch} />
          ) : clients.loading ? (
            <Spinner label="Loading clients…" />
          ) : (clients.data?.clients.length ?? 0) === 0 ? (
            <EmptyState
              title="No clients yet"
              description="Create a client to get a CONNECT_CLIENT_ID / CONNECT_CLIENT_SECRET pair for this project."
              action={<Button onClick={() => setCreateOpen(true)}>Create client</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client ID</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.data?.clients.map((client) => (
                  <TableRow key={client.clientId}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <code className="font-mono text-xs">{client.clientId}</code>
                        <CopyButton value={client.clientId} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge>{client.environment}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(client.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(client)}>
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create workload client"
        description="The client secret is shown exactly once after creation."
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="client-env">Environment</Label>
            <Select
              id="client-env"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as Environment)}
            >
              {ENVIRONMENTS.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </Select>
          </div>
          {createError ? <p className="text-sm text-red-700">{createError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button loading={creating} onClick={() => void createClient()}>
              Create
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Client created"
        description="Copy the secret now — it will not be shown again."
        wide
      >
        {created ? (
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-700">.env snippet</p>
                <CopyButton value={envSnippet} />
              </div>
              <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-950 p-4 font-mono text-xs leading-6 text-zinc-100">
                {envSnippet}
              </pre>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setCreated(null)}>Done</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await deleteClient(deleteTarget);
        }}
        title="Delete client"
        description={`Delete client ${deleteTarget?.clientId ?? ''}? Workloads using it will no longer be able to mint tokens.`}
      />
    </div>
  );
}
