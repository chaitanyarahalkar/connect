'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/use-api';
import { apiFetch } from '@/lib/api';
import { slugify, formatDate } from '@/lib/utils';
import type { Project } from '@/lib/types';
import { Button } from '@/components/ui/button';
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
import { useToast } from '@/components/toast';

export default function ProjectsPage() {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi<{ projects: Project[] }>('/v1/projects');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setCreateError(null);
    try {
      await apiFetch('/v1/projects', { method: 'POST', body: { name, slug } });
      setCreateOpen(false);
      setName('');
      setSlug('');
      setSlugTouched(false);
      toast('Project created');
      refetch();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const projects = data?.projects ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-zinc-500">
            Applications that request credentials via workload identities.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New project</Button>
      </div>

      {error ? (
        <ErrorText error={error} onRetry={refetch} />
      ) : loading ? (
        <Spinner label="Loading projects…" />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create a project, link connectors to it, then issue workload clients so your app can mint tokens."
          action={<Button onClick={() => setCreateOpen(true)}>Create project</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link
                    href={`/projects/${project.id}`}
                    className="font-medium text-zinc-900 underline-offset-2 hover:underline"
                  >
                    {project.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{project.slug}</TableCell>
                <TableCell>{formatDate(project.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New project"
        description="Projects group workload clients and connector links."
      >
        <form onSubmit={(e) => void create(e)} className="space-y-4">
          <div>
            <Label htmlFor="p-name">Name</Label>
            <Input
              id="p-name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="my-app"
            />
          </div>
          <div>
            <Label htmlFor="p-slug">Slug</Label>
            <Input
              id="p-slug"
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="my-app"
            />
          </div>
          {createError ? <p className="text-sm text-red-700">{createError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
