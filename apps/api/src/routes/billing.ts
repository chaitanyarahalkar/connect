import {
  BILLING_PLANS,
  billingPeriodFromString,
  billingPeriodOf,
  ConnectError,
  computeInvoice,
  PLAN_KEYS,
} from '@connect/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { type AuthEnv, requireRole } from '../auth/middleware.js';
import {
  aggregateUsage,
  generateInvoice,
  type InvoiceRow,
  listInvoices,
  planFor,
  setPlan,
} from '../billing/service.js';
import type { AppDeps } from '../deps.js';

export function billingRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  /** Plan + current-period usage + the projected invoice for that usage. */
  app.get('/', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const plan = await planFor(deps.db, principal.orgId);
    const period = billingPeriodOf(new Date());
    const usage = await aggregateUsage(deps.db, principal.orgId, period.start, period.end);
    const projection = computeInvoice(plan, usage);
    return c.json({
      plan: { key: plan.key, name: plan.name, baseCents: plan.baseCents },
      plans: Object.values(BILLING_PLANS),
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      usage,
      included: plan.included,
      projection,
    });
  });

  app.patch('/plan', zValidator('json', z.object({ plan: z.enum(PLAN_KEYS) })), async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'owner');
    const { plan } = c.req.valid('json');
    await setPlan(deps.db, principal.orgId, plan);
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'billing.plan.change',
      targetType: 'org',
      targetId: principal.orgId,
      metadata: { plan },
    });
    return c.json({ plan });
  });

  app.get('/invoices', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const rows = await listInvoices(deps.db, principal.orgId);
    return c.json({ invoices: rows.map(serializeInvoice) });
  });

  /** Generate/refresh the invoice for a period (default: the previous month). */
  app.post(
    '/invoices/generate',
    zValidator('json', z.object({ period: z.string().optional() })),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'owner');
      const input = c.req.valid('json');
      let start: Date;
      if (input.period) {
        const parsed = billingPeriodFromString(input.period);
        if (!parsed) throw new ConnectError('validation_error', 'period must be YYYY-MM');
        start = parsed.start;
      } else {
        const now = new Date();
        start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      }
      const invoice = await generateInvoice(deps.db, principal.orgId, start);
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'billing.invoice.generate',
        targetType: 'invoice',
        targetId: invoice.id,
        metadata: { period: invoice.periodStart.toISOString().slice(0, 7) },
      });
      return c.json({ invoice: serializeInvoice(invoice) }, 201);
    },
  );

  return app;
}

function serializeInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    planKey: row.planKey,
    lines: row.lines,
    totalCents: row.totalCents,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
