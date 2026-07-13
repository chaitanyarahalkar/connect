'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useOrg } from '@/lib/org-context';
import { apiFetch } from '@/lib/api';
import { slugify, cn } from '@/lib/utils';
import type { Org } from '@/lib/types';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/toast';

export function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrg, refetchOrgs } = useOrg();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const createOrg = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await apiFetch<{ organization: Org }>('/v1/orgs', {
        method: 'POST',
        body: { name, slug },
      });
      await refetchOrgs();
      setActiveOrg(res.organization.slug);
      setCreateOpen(false);
      setName('');
      setSlug('');
      setSlugTouched(false);
      toast(`Organization "${res.organization.name}" created`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
      >
        <span className="truncate">{activeOrg?.name ?? 'Select organization'}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-zinc-400">
          <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
        </svg>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 z-40 mt-1 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          {orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => {
                setActiveOrg(org.slug);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50',
                org.slug === activeOrg?.slug ? 'font-semibold text-zinc-900' : 'text-zinc-700',
              )}
            >
              <span className="truncate">{org.name}</span>
              <span className="ml-2 shrink-0 text-xs text-zinc-400">{org.role}</span>
            </button>
          ))}
          <div className="my-1 border-t border-zinc-100" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
            className="w-full px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            + Create organization
          </button>
        </div>
      ) : null}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create organization"
        description="A new workspace for connectors and projects."
      >
        <form onSubmit={(e) => void createOrg(e)} className="space-y-4">
          <div>
            <Label htmlFor="new-org-name">Name</Label>
            <Input
              id="new-org-name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Acme Inc"
            />
          </div>
          <div>
            <Label htmlFor="new-org-slug">Slug</Label>
            <Input
              id="new-org-slug"
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="acme"
            />
          </div>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
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
