'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/auth-client';
import { apiFetch, storeOrgSlug, getStoredOrgSlug } from '@/lib/api';
import type { Org } from '@/lib/types';
import { Spinner } from '@/components/feedback';

export default function IndexPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    if (!session) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    apiFetch<{ organizations: Org[] }>('/v1/orgs', { orgSlug: null })
      .then((res) => {
        if (cancelled) return;
        if (res.organizations.length === 0) {
          router.replace('/onboarding');
        } else {
          const stored = getStoredOrgSlug();
          const active =
            res.organizations.find((o) => o.slug === stored) ?? res.organizations[0];
          if (active) storeOrgSlug(active.slug);
          router.replace('/overview');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isPending, session, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      {failed ? (
        <p className="text-sm text-red-700">Failed to load your organizations: {failed}</p>
      ) : (
        <Spinner label="Loading Connect…" />
      )}
    </main>
  );
}
