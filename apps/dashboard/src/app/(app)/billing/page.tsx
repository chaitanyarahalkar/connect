'use client';

import { useState } from 'react';
import { ErrorText, Spinner } from '@/components/feedback';
import { useToast } from '@/components/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import type { Me } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

type UsageKind = 'token_request' | 'webhook_delivery';

interface PlanSummary {
  key: string;
  name: string;
  baseCents: number;
  included: Record<UsageKind, number>;
  overagePerThousandCents: Record<UsageKind, number>;
}

interface InvoiceLine {
  description: string;
  kind: UsageKind | 'base';
  quantity: number;
  amountCents: number;
}

interface BillingSummary {
  plan: { key: string; name: string; baseCents: number };
  plans: PlanSummary[];
  period: { start: string; end: string };
  usage: Record<UsageKind, number>;
  included: Record<UsageKind, number>;
  projection: { lines: InvoiceLine[]; totalCents: number };
}

interface Invoice {
  id: string;
  periodStart: string;
  periodEnd: string;
  planKey: string;
  lines: InvoiceLine[];
  totalCents: number;
  status: 'draft' | 'final';
  createdAt: string;
}

const USAGE_LABELS: Record<UsageKind, string> = {
  token_request: 'Token requests',
  webhook_delivery: 'Webhook deliveries',
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function BillingPage() {
  const { toast } = useToast();
  const { data, loading, error, refetch } = useApi<BillingSummary>('/v1/billing');
  const invoicesApi = useApi<{ invoices: Invoice[] }>('/v1/billing/invoices');
  const { data: me } = useApi<Me>('/v1/me');
  const isOwner = me?.principal.role === 'owner';

  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const changePlan = async (plan: string) => {
    setChangingPlan(plan);
    try {
      await apiFetch('/v1/billing/plan', { method: 'PATCH', body: { plan } });
      toast(`Plan changed to ${plan}`);
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setChangingPlan(null);
    }
  };

  const generateInvoice = async () => {
    setGenerating(true);
    try {
      const res = await apiFetch<{ invoice: Invoice }>('/v1/billing/invoices/generate', {
        method: 'POST',
        body: {},
      });
      toast(`Invoice generated for ${monthLabel(res.invoice.periodStart)}`);
      invoicesApi.refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setGenerating(false);
    }
  };

  if (error) return <ErrorText error={error} onRetry={refetch} />;
  if (loading || !data) return <Spinner label="Loading billing…" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-zinc-500">
          Metered from usage events · current period {monthLabel(data.period.start)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {data.plans.map((plan) => {
          const current = plan.key === data.plan.key;
          return (
            <Card key={plan.key} className={cn(current && 'border-zinc-900 ring-1 ring-zinc-900')}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-zinc-900">{plan.name}</p>
                  {current ? <Badge variant="success">current</Badge> : null}
                </div>
                <p className="mt-1 text-2xl font-semibold tracking-tight">
                  {dollars(plan.baseCents)}
                  <span className="text-sm font-normal text-zinc-500">/mo</span>
                </p>
                <ul className="mt-2 space-y-1 text-xs text-zinc-600">
                  <li>{plan.included.token_request.toLocaleString('en-US')} token requests</li>
                  <li>{plan.included.webhook_delivery.toLocaleString('en-US')} deliveries</li>
                  <li>
                    {plan.overagePerThousandCents.token_request === 0
                      ? 'No overage billing'
                      : `then ${dollars(plan.overagePerThousandCents.token_request)}/1k requests`}
                  </li>
                </ul>
                {isOwner && !current ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    loading={changingPlan === plan.key}
                    onClick={() => void changePlan(plan.key)}
                  >
                    Switch to {plan.name}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current period usage</CardTitle>
          <CardDescription>
            Projected total for {monthLabel(data.period.start)}:{' '}
            <span className="font-medium text-zinc-900">{dollars(data.projection.totalCents)}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(Object.keys(USAGE_LABELS) as UsageKind[]).map((kind) => {
            const used = data.usage[kind] ?? 0;
            const included = data.included[kind] ?? 0;
            const pct = included === 0 ? 100 : Math.min(100, (used / included) * 100);
            return (
              <div key={kind}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="text-zinc-700">{USAGE_LABELS[kind]}</span>
                  <span className="tabular-nums text-zinc-500">
                    {used.toLocaleString('en-US')} / {included.toLocaleString('en-US')} included
                  </span>
                </div>
                <div className="h-2 rounded-full bg-zinc-100">
                  <div
                    className={cn(
                      'h-2 rounded-full',
                      used > included ? 'bg-amber-500' : 'bg-zinc-900',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Invoices</CardTitle>
              <CardDescription>
                Generated from metered usage. Invoices finalize when their month closes.
              </CardDescription>
            </div>
            {isOwner ? (
              <Button
                variant="outline"
                size="sm"
                loading={generating}
                onClick={() => void generateInvoice()}
              >
                Generate for last month
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {invoicesApi.error ? (
            <ErrorText error={invoicesApi.error} onRetry={invoicesApi.refetch} />
          ) : invoicesApi.loading ? (
            <Spinner label="Loading invoices…" />
          ) : (invoicesApi.data?.invoices.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500">No invoices generated yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoicesApi.data!.invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium text-zinc-900">
                      {monthLabel(inv.periodStart)}
                    </TableCell>
                    <TableCell className="capitalize">{inv.planKey}</TableCell>
                    <TableCell>
                      <Badge variant={inv.status === 'final' ? 'success' : 'secondary'}>
                        {inv.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {dollars(inv.totalCents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
