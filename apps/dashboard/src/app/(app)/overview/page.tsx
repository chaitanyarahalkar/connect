'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/use-api';
import type { Connector, Project, UsageRow } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner, ErrorText } from '@/components/feedback';

function isoDay(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

export default function OverviewPage() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: isoDay(first), to: isoDay(now) };
  }, []);

  const usage = useApi<{ daily: UsageRow[] }>(`/v1/usage?from=${from}&to=${to}`);
  const connectors = useApi<{ connectors: Connector[] }>('/v1/connectors');
  const projects = useApi<{ projects: Project[] }>('/v1/projects');

  const stats = useMemo(() => {
    const daily = usage.data?.daily ?? [];
    const tokenRequests = daily
      .filter((r) => r.kind === 'token_request')
      .reduce((sum, r) => sum + r.total, 0);
    const webhookDeliveries = daily
      .filter((r) => r.kind === 'webhook_delivery')
      .reduce((sum, r) => sum + r.total, 0);
    return { tokenRequests, webhookDeliveries };
  }, [usage.data]);

  const chart = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const row of usage.data?.daily ?? []) {
      if (row.kind !== 'token_request') continue;
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.total);
    }
    const days: Array<{ day: string; total: number }> = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = isoDay(d);
      days.push({ day: key, total: byDay.get(key) ?? 0 });
    }
    const max = Math.max(1, ...days.map((x) => x.total));
    return { days, max };
  }, [usage.data, from, to]);

  const activeConnectors =
    connectors.data?.connectors.filter((c) => c.status === 'active').length ?? null;

  const loading = usage.loading || connectors.loading || projects.loading;
  const error = usage.error ?? connectors.error ?? projects.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-zinc-500">Activity for the current month.</p>
      </div>

      {error ? (
        <ErrorText
          error={error}
          onRetry={() => {
            usage.refetch();
            connectors.refetch();
            projects.refetch();
          }}
        />
      ) : loading ? (
        <Spinner label="Loading overview…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Token requests" value={stats.tokenRequests} sub="this month" />
            <StatCard label="Webhook deliveries" value={stats.webhookDeliveries} sub="this month" />
            <StatCard
              label="Active connectors"
              value={activeConnectors ?? 0}
              sub={<Link href="/connectors" className="underline underline-offset-2">view all</Link>}
            />
            <StatCard
              label="Projects"
              value={projects.data?.projects.length ?? 0}
              sub={<Link href="/projects" className="underline underline-offset-2">view all</Link>}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Daily token requests</CardTitle>
              <CardDescription>
                {from} → {to}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {chart.days.every((d) => d.total === 0) ? (
                <p className="py-8 text-center text-sm text-zinc-500">
                  No token requests yet this month. Mint one in the{' '}
                  <Link href="/playground" className="font-medium text-zinc-800 underline underline-offset-2">
                    Playground
                  </Link>
                  .
                </p>
              ) : (
                <div className="flex h-40 items-end gap-1">
                  {chart.days.map((d) => (
                    <div
                      key={d.day}
                      className="group relative flex-1"
                      title={`${d.day}: ${d.total}`}
                    >
                      <div
                        className="w-full rounded-t bg-zinc-800 transition-colors group-hover:bg-zinc-600"
                        style={{ height: `${Math.max(2, (d.total / chart.max) * 160)}px` }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <p className="mt-2 text-3xl font-semibold tabular-nums text-zinc-900">
          {value.toLocaleString()}
        </p>
        {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}
