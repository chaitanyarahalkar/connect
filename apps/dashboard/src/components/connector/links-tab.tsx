'use client';

import Link from 'next/link';
import { type FormEvent, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorText, Spinner } from '@/components/feedback';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { apiFetch } from '@/lib/api';
import type { Connector, Environment, Project, ProjectLink } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const ENVIRONMENTS: Environment[] = ['production', 'preview', 'development'];

export function LinksTab({ connector }: { connector: Connector }) {
  const { toast } = useToast();
  const links = useApi<{ links: ProjectLink[] }>(`/v1/links?connector=${connector.id}`);
  const projects = useApi<{ projects: Project[] }>('/v1/projects');

  const [selectedProject, setSelectedProject] = useState('');
  const [newEnvs, setNewEnvs] = useState<Environment[]>(['production']);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectLink | null>(null);
  const [savingLinkId, setSavingLinkId] = useState<string | null>(null);

  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects.data?.projects ?? []) map.set(p.id, p);
    return map;
  }, [projects.data]);

  const linkedProjectIds = new Set((links.data?.links ?? []).map((l) => l.projectId));
  const availableProjects = (projects.data?.projects ?? []).filter(
    (p) => !linkedProjectIds.has(p.id),
  );

  const addLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedProject) {
      setAddError('Choose a project');
      return;
    }
    if (newEnvs.length === 0) {
      setAddError('Select at least one environment');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await apiFetch('/v1/links', {
        method: 'POST',
        body: { project: selectedProject, connector: connector.id, environments: newEnvs },
      });
      setSelectedProject('');
      setNewEnvs(['production']);
      toast('Project linked');
      links.refetch();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const updateEnvironments = async (link: ProjectLink, envs: Environment[]) => {
    if (envs.length === 0) {
      toast('A link needs at least one environment', 'error');
      return;
    }
    setSavingLinkId(link.id);
    try {
      await apiFetch('/v1/links', {
        method: 'POST',
        body: {
          project: link.projectId,
          connector: connector.id,
          environments: envs,
          ...(link.defaultInstallationId
            ? { defaultInstallationId: link.defaultInstallationId }
            : {}),
        },
      });
      links.refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSavingLinkId(null);
    }
  };

  const deleteLink = async (link: ProjectLink) => {
    try {
      await apiFetch(`/v1/links/${link.id}`, { method: 'DELETE' });
      toast('Link removed');
      links.refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  };

  if (links.error) return <ErrorText error={links.error} onRetry={links.refetch} />;
  if (projects.error) return <ErrorText error={projects.error} onRetry={projects.refetch} />;
  if (links.loading || projects.loading) return <Spinner label="Loading links…" />;

  const rows = links.data?.links ?? [];

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState
          title="No projects linked"
          description="Link a project so its workloads can request tokens from this connector."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Environments</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((link) => {
              const project = projectById.get(link.projectId);
              return (
                <TableRow key={link.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${link.projectId}`}
                      className="font-medium text-zinc-900 underline-offset-2 hover:underline"
                    >
                      {project?.name ?? link.projectId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-3">
                      {ENVIRONMENTS.map((env) => {
                        const checked = link.environments.includes(env);
                        return (
                          <label key={env} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-zinc-300"
                              disabled={savingLinkId === link.id}
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...link.environments, env]
                                  : link.environments.filter((x) => x !== env);
                                void updateEnvironments(link, next);
                              }}
                            />
                            {env}
                          </label>
                        );
                      })}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(link)}>
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Link a project</CardTitle>
          <CardDescription>
            Grant a project&apos;s workloads access to this connector per environment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(projects.data?.projects.length ?? 0) === 0 ? (
            <p className="text-sm text-zinc-500">
              No projects yet.{' '}
              <Link
                href="/projects"
                className="font-medium text-zinc-800 underline underline-offset-2"
              >
                Create one first
              </Link>
              .
            </p>
          ) : (
            <form onSubmit={(e) => void addLink(e)} className="flex flex-wrap items-end gap-4">
              <div className="min-w-56">
                <Label htmlFor="link-project">Project</Label>
                <Select
                  id="link-project"
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                >
                  <option value="">Choose a project…</option>
                  {availableProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex items-center gap-3 pb-2">
                {ENVIRONMENTS.map((env) => (
                  <label key={env} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-zinc-300"
                      checked={newEnvs.includes(env)}
                      onChange={(e) =>
                        setNewEnvs((prev) =>
                          e.target.checked ? [...prev, env] : prev.filter((x) => x !== env),
                        )
                      }
                    />
                    {env}
                  </label>
                ))}
              </div>
              <Button type="submit" loading={adding}>
                Link project
              </Button>
              {addError ? <p className="w-full text-sm text-red-700">{addError}</p> : null}
            </form>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await deleteLink(deleteTarget);
        }}
        title="Remove link"
        description={`Unlink "${projectById.get(deleteTarget?.projectId ?? '')?.name ?? 'this project'}" from ${connector.name}? Its workloads will no longer be able to mint tokens for this connector.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
