import { newId, usageEvents } from '@connect/db';
import { BILLING_PLANS, computeInvoice } from '@connect/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  createHarness,
  ensureMigrated,
  json,
  resetState,
  type SeededOrg,
  seedOrg,
  type TestHarness,
} from './helpers.js';

let h: TestHarness;
let org: SeededOrg;

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness();
  org = await seedOrg(h.deps);
});

afterAll(async () => {
  await h.cleanup();
});

async function insertUsage(kind: 'token_request' | 'webhook_delivery', qty: number, at: Date) {
  await h.deps.db.insert(usageEvents).values({
    id: newId.usage(),
    orgId: org.orgId,
    connectorId: org.apiKeyConnectorId,
    kind,
    quantity: qty,
    occurredAt: at,
  });
}

function lastMonth(): { start: Date; label: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, label: start.toISOString().slice(0, 7) };
}

describe('invoice math', () => {
  it('charges base plus per-kind overage beyond the included quota', () => {
    const result = computeInvoice(BILLING_PLANS.pro, {
      token_request: 150_000, // 50k over, at 10c/1k => $5.00
      webhook_delivery: 9_000, // under quota
    });
    expect(result.totalCents).toBe(2000 + 500);
    const tokenLine = result.lines.find((l) => l.kind === 'token_request')!;
    expect(tokenLine.quantity).toBe(50_000);
    expect(tokenLine.amountCents).toBe(500);
    expect(result.lines.find((l) => l.kind === 'webhook_delivery')!.amountCents).toBe(0);
  });

  it('never bills overage on the free plan', () => {
    const result = computeInvoice(BILLING_PLANS.free, {
      token_request: 1_000_000,
      webhook_delivery: 50_000,
    });
    expect(result.totalCents).toBe(0);
  });
});

describe('billing API', () => {
  it('defaults to the free plan with current-period usage', async () => {
    const res = await h.app.request('/v1/billing', authed(org.pat));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.plan.key).toBe('free');
    expect(body.plans.map((p: { key: string }) => p.key)).toEqual(['free', 'pro', 'scale']);
    expect(body.usage).toHaveProperty('token_request');
    expect(new Date(body.period.start).getUTCDate()).toBe(1);
  });

  it('reflects metered usage in the current period', async () => {
    // one real token request through the API...
    const mint = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: org.apiKeyConnectorId }),
    );
    expect(mint.status).toBe(200);
    // ...plus synthetic bulk usage
    await insertUsage('token_request', 499, new Date());
    const body = await json(await h.app.request('/v1/billing', authed(org.pat)));
    expect(body.usage.token_request).toBe(500);
  });

  it('lets the owner change plans and audits it', async () => {
    const res = await h.app.request('/v1/billing/plan', {
      ...authed(org.pat, { plan: 'pro' }),
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    const body = await json(await h.app.request('/v1/billing', authed(org.pat)));
    expect(body.plan.key).toBe('pro');
    expect(body.included.token_request).toBe(100_000);
  });

  it('generates a finalized invoice for the previous month with overage', async () => {
    const { start, label } = lastMonth();
    const mid = new Date(start.getTime() + 10 * 86_400_000);
    await insertUsage('token_request', 150_000, mid);
    await insertUsage('webhook_delivery', 12_000, mid);

    const res = await h.app.request('/v1/billing/invoices/generate', {
      ...authed(org.pat, {}),
      method: 'POST',
    });
    expect(res.status).toBe(201);
    const { invoice } = await json(res);
    expect(invoice.periodStart.slice(0, 7)).toBe(label);
    expect(invoice.status).toBe('final');
    expect(invoice.planKey).toBe('pro');
    // pro: $20 base + 50k token overage ($5) + 2k delivery overage ($1)
    expect(invoice.totalCents).toBe(2000 + 500 + 100);

    const list = await json(await h.app.request('/v1/billing/invoices', authed(org.pat)));
    expect(list.invoices).toHaveLength(1);
  });

  it('refuses to regenerate a finalized invoice', async () => {
    const res = await h.app.request('/v1/billing/invoices/generate', {
      ...authed(org.pat, {}),
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it('keeps a current-month invoice as a regenerable draft', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const first = await h.app.request('/v1/billing/invoices/generate', {
      ...authed(org.pat, { period }),
      method: 'POST',
    });
    expect(first.status).toBe(201);
    expect((await json(first)).invoice.status).toBe('draft');

    await insertUsage('token_request', 200_000, new Date());
    const second = await h.app.request('/v1/billing/invoices/generate', {
      ...authed(org.pat, { period }),
      method: 'POST',
    });
    expect(second.status).toBe(201);
    const regenerated = (await json(second)).invoice;
    expect(regenerated.status).toBe('draft');
    // 200k synthetic + 500 earlier = 100.5k over pro's included 100k → $10.05 + $20 base
    expect(regenerated.totalCents).toBe(2000 + 1005);

    // still a single invoice row per period
    const list = await json(await h.app.request('/v1/billing/invoices', authed(org.pat)));
    expect(
      list.invoices.filter((i: { periodStart: string }) => i.periodStart.slice(0, 7) === period),
    ).toHaveLength(1);
  });

  it('rejects invalid periods and future periods', async () => {
    const bad = await h.app.request('/v1/billing/invoices/generate', {
      ...authed(org.pat, { period: '2025-13' }),
      method: 'POST',
    });
    expect(bad.status).toBe(400);

    const next = new Date();
    const future = `${next.getUTCFullYear() + 1}-01`;
    const res = await h.app.request('/v1/billing/invoices/generate', {
      ...authed(org.pat, { period: future }),
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('blocks non-owners from changing plans', async () => {
    const { memberships, accessTokens } = await import('@connect/db');
    const { generateSecret, randomToken } = await import('@connect/crypto');
    const { user } = await import('@connect/db');
    const memberId = newId.user();
    await h.deps.db.insert(user).values({
      id: memberId,
      name: 'Member',
      email: `member-${randomToken(6)}@test.dev`,
      emailVerified: true,
    });
    await h.deps.db.insert(memberships).values({
      id: newId.membership(),
      orgId: org.orgId,
      userId: memberId,
      role: 'member',
    });
    const pat = generateSecret('cn_pat_');
    await h.deps.db.insert(accessTokens).values({
      id: newId.accessToken(),
      orgId: org.orgId,
      userId: memberId,
      name: 'member-pat',
      tokenHash: pat.hash,
      tokenPrefix: pat.prefix,
    });

    const res = await h.app.request('/v1/billing/plan', {
      ...authed(pat.plaintext, { plan: 'scale' }),
      method: 'PATCH',
    });
    expect(res.status).toBe(403);
  });
});
