'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { ErrorText, Spinner } from '@/components/feedback';
import { OrgSwitcher } from '@/components/org-switcher';
import { signOut, useSession } from '@/lib/auth-client';
import { OrgProvider, useOrg } from '@/lib/org-context';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/overview', label: 'Overview' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/projects', label: 'Projects' },
  { href: '/playground', label: 'Playground' },
  { href: '/settings', label: 'Settings' },
] as const;

function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const { orgs, loading: orgsLoading, error: orgsError, refetchOrgs } = useOrg();

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  useEffect(() => {
    if (!orgsLoading && !orgsError && orgs.length === 0) router.replace('/onboarding');
  }, [orgsLoading, orgsError, orgs.length, router]);

  if (isPending || (orgsLoading && orgs.length === 0)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (!session) return null;

  if (orgsError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md">
          <ErrorText error={orgsError} onRetry={() => void refetchOrgs()} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-zinc-200 bg-white">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 font-mono text-sm font-bold text-white">
            C
          </span>
          <span className="text-lg font-semibold tracking-tight">Connect</span>
        </div>
        <div className="px-3 pb-3">
          <OrgSwitcher />
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-zinc-200 px-4 py-3">
          <p className="truncate text-xs text-zinc-500" title={session.user.email}>
            {session.user.email}
          </p>
          <button
            type="button"
            onClick={() =>
              void signOut({ fetchOptions: { onSuccess: () => router.push('/login') } })
            }
            className="mt-1 text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="ml-60 min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <OrgProvider>
      <Shell>{children}</Shell>
    </OrgProvider>
  );
}
