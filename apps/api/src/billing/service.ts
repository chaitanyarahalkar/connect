import { type Db, invoices, newId, orgBilling, usageEvents } from '@connect/db';
import {
  BILLING_PLANS,
  type BillingPlan,
  billingPeriodOf,
  ConnectError,
  computeInvoice,
  type PlanKey,
  type UsageTotals,
} from '@connect/shared';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';

export async function planFor(db: Db, orgId: string): Promise<BillingPlan> {
  const [row] = await db.select().from(orgBilling).where(eq(orgBilling.orgId, orgId)).limit(1);
  const key = (row?.planKey ?? 'free') as PlanKey;
  return BILLING_PLANS[key] ?? BILLING_PLANS.free;
}

export async function setPlan(db: Db, orgId: string, planKey: PlanKey): Promise<void> {
  await db
    .insert(orgBilling)
    .values({ orgId, planKey })
    .onConflictDoUpdate({
      target: orgBilling.orgId,
      set: { planKey, updatedAt: new Date() },
    });
}

/** Sums usage_events per kind over [from, to). */
export async function aggregateUsage(
  db: Db,
  orgId: string,
  from: Date,
  to: Date,
): Promise<UsageTotals> {
  const rows = await db
    .select({
      kind: usageEvents.kind,
      total: sql<number>`sum(${usageEvents.quantity})::int`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        gte(usageEvents.occurredAt, from),
        lt(usageEvents.occurredAt, to),
      ),
    )
    .groupBy(usageEvents.kind);
  const totals: UsageTotals = { token_request: 0, webhook_delivery: 0 };
  for (const row of rows) totals[row.kind] = row.total;
  return totals;
}

export type InvoiceRow = typeof invoices.$inferSelect;

/**
 * Generates (or refreshes) the invoice for the calendar month starting at
 * `periodStart`. Invoices for open periods stay draft and are regenerated on
 * demand; once a period has closed the invoice is final and immutable.
 */
export async function generateInvoice(
  db: Db,
  orgId: string,
  periodStart: Date,
): Promise<InvoiceRow> {
  const period = billingPeriodOf(periodStart);
  if (period.start.getTime() !== periodStart.getTime()) {
    throw new ConnectError('validation_error', 'periodStart must be the first of a month (UTC)');
  }
  if (period.start > new Date()) {
    throw new ConnectError('validation_error', 'cannot invoice a future period');
  }

  const [existing] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), eq(invoices.periodStart, period.start)))
    .limit(1);
  if (existing?.status === 'final') {
    throw new ConnectError('conflict', 'invoice for this period is already finalized');
  }

  const plan = await planFor(db, orgId);
  const usage = await aggregateUsage(db, orgId, period.start, period.end);
  const computation = computeInvoice(plan, usage);
  const status = period.end <= new Date() ? 'final' : 'draft';

  const values = {
    orgId,
    periodStart: period.start,
    periodEnd: period.end,
    planKey: plan.key,
    lines: computation.lines,
    totalCents: computation.totalCents,
    status,
  } as const;

  if (existing) {
    const [updated] = await db
      .update(invoices)
      .set({ ...values, createdAt: new Date() })
      .where(eq(invoices.id, existing.id))
      .returning();
    return updated!;
  }
  const [created] = await db
    .insert(invoices)
    .values({ id: newId.invoice(), ...values })
    .returning();
  return created!;
}

export async function listInvoices(db: Db, orgId: string): Promise<InvoiceRow[]> {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.orgId, orgId))
    .orderBy(desc(invoices.periodStart));
}
