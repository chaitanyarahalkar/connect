'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/auth-client';
import { apiFetch, storeOrgSlug } from '@/lib/api';
import { slugify } from '@/lib/utils';
import type { Org } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await apiFetch<{ organization: Org }>('/v1/orgs', {
        method: 'POST',
        body: { name, slug },
        orgSlug: null,
      });
      storeOrgSlug(res.organization.slug);
      router.push('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 font-mono text-sm font-bold text-white">
              C
            </span>
            <span className="text-lg font-semibold tracking-tight">Connect</span>
          </div>
          <CardTitle>Create your organization</CardTitle>
          <CardDescription>
            Connectors, projects and tokens are scoped to an organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            <div>
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
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
              <Label htmlFor="org-slug">Slug</Label>
              <Input
                id="org-slug"
                required
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="acme"
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                title="Lowercase letters, digits and hyphens"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Lowercase letters, digits and hyphens. Used in API headers.
              </p>
            </div>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            <Button type="submit" className="w-full" loading={pending}>
              Create organization
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
