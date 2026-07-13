/**
 * Billing catalog + invoice math over usage_events. Plans are code, not DB
 * rows — an org's only billing state is its plan key (org_billing) and the
 * invoices generated from metered usage.
 */

export const USAGE_KINDS = ['token_request', 'webhook_delivery'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const PLAN_KEYS = ['free', 'pro', 'scale'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface BillingPlan {
  key: PlanKey;
  name: string;
  /** Monthly base price in cents. */
  baseCents: number;
  /** Usage included in the base price, per kind. */
  included: Record<UsageKind, number>;
  /** Overage price per 1,000 events in cents. 0 = overage is not billed. */
  overagePerThousandCents: Record<UsageKind, number>;
}

export const BILLING_PLANS: Record<PlanKey, BillingPlan> = {
  free: {
    key: 'free',
    name: 'Free',
    baseCents: 0,
    included: { token_request: 10_000, webhook_delivery: 1_000 },
    overagePerThousandCents: { token_request: 0, webhook_delivery: 0 },
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    baseCents: 2_000,
    included: { token_request: 100_000, webhook_delivery: 10_000 },
    overagePerThousandCents: { token_request: 10, webhook_delivery: 50 },
  },
  scale: {
    key: 'scale',
    name: 'Scale',
    baseCents: 20_000,
    included: { token_request: 2_000_000, webhook_delivery: 100_000 },
    overagePerThousandCents: { token_request: 5, webhook_delivery: 25 },
  },
};

export type UsageTotals = Record<UsageKind, number>;

export interface InvoiceLine {
  description: string;
  kind: UsageKind | 'base';
  quantity: number;
  amountCents: number;
}

export interface InvoiceComputation {
  lines: InvoiceLine[];
  totalCents: number;
}

/** Deterministic invoice math: base price + per-kind overage beyond the included quota. */
export function computeInvoice(plan: BillingPlan, usage: UsageTotals): InvoiceComputation {
  const lines: InvoiceLine[] = [
    {
      description: `${plan.name} plan`,
      kind: 'base',
      quantity: 1,
      amountCents: plan.baseCents,
    },
  ];
  for (const kind of USAGE_KINDS) {
    const used = usage[kind] ?? 0;
    const overage = Math.max(0, used - plan.included[kind]);
    const rate = plan.overagePerThousandCents[kind];
    const amountCents = rate === 0 ? 0 : Math.ceil((overage / 1000) * rate);
    lines.push({
      description: `${kind === 'token_request' ? 'Token requests' : 'Webhook deliveries'} — ${used.toLocaleString('en-US')} used, ${plan.included[kind].toLocaleString('en-US')} included`,
      kind,
      quantity: overage,
      amountCents,
    });
  }
  return { lines, totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0) };
}

/** UTC calendar-month period containing `at`. End is exclusive. */
export function billingPeriodOf(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Parses "YYYY-MM" into a billing period. */
export function billingPeriodFromString(period: string): { start: Date; end: Date } | null {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}
