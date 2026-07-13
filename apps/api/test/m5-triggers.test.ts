import { createHmac } from 'node:crypto';
import { webhookDeliveries } from '@connect/db';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeliveryWorker } from '../src/webhooks/queue.js';
import { verifyGenericSignature } from '../src/webhooks/verify.js';
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
let worker: Worker;
let connectorId: string;
let ingestKey: string;
let triggerId: string;
let signingSecret: string;

const WEBHOOK_SECRET = 'provider-webhook-secret';

/** Requests the delivery worker makes to trigger destinations. */
const destinationCalls: { url: string; headers: Record<string, string>; body: string }[] = [];
let destinationStatus = 200;

const destinationFetch: typeof fetch = (async (input: unknown, init?: unknown) => {
  const url = String(input);
  if (url.startsWith('https://consumer.test/')) {
    const req = (init ?? {}) as RequestInit;
    destinationCalls.push({
      url,
      headers: (req.headers ?? {}) as Record<string, string>,
      body: String(req.body ?? ''),
    });
    return new Response('ok', { status: destinationStatus });
  }
  throw new Error(`unexpected outbound fetch to ${url}`);
}) as typeof fetch;

function sign(payload: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')}`;
}

function ingest(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return h.app.request(`/v1/webhooks/${connectorId}/${ingestKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-signature': sign(body), ...headers },
    body,
  });
}

/** Waits until every delivery for the trigger reaches a terminal-enough state. */
async function waitForDeliveries(
  predicate: (rows: (typeof webhookDeliveries.$inferSelect)[]) => boolean,
) {
  for (let i = 0; i < 50; i++) {
    const rows = await h.deps.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.triggerId, triggerId));
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for deliveries');
}

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness({ providerFetch: destinationFetch });
  org = await seedOrg(h.deps);
  worker = createDeliveryWorker(h.deps, { concurrency: 2 });

  const created = await json(
    await h.app.request(
      '/v1/connectors',
      authed(org.pat, {
        slug: 'events-svc',
        name: 'Events Service',
        type: 'api_key',
        secrets: { apiKey: 'k', webhookSecret: WEBHOOK_SECRET },
      }),
    ),
  );
  connectorId = created.connector.id;
  ingestKey = created.connector.ingestKey;

  const trig = await json(
    await h.app.request(
      `/v1/connectors/${connectorId}/triggers`,
      authed(org.pat, { name: 'main destination', destinationUrl: 'https://consumer.test/hooks' }),
    ),
  );
  triggerId = trig.trigger.id;
  signingSecret = trig.trigger.signingSecret;
  expect(signingSecret).toMatch(/^whsec_/);
});

afterAll(async () => {
  await worker.close();
  await h.cleanup();
});

describe('webhook ingest → delivery', () => {
  it('verifies, stores, fans out, and signs the forwarded request', async () => {
    const res = await ingest({ type: 'user.created', userId: 'u1' }, { 'x-webhook-id': 'evt-1' });
    expect(res.status).toBe(200);
    expect((await json(res)).deliveries).toBe(1);

    await waitForDeliveries((rows) => rows.some((r) => r.status === 'succeeded'));
    const call = destinationCalls.at(-1)!;
    expect(call.url).toBe('https://consumer.test/hooks');
    expect(call.headers['connect-event-type']).toBe('user.created');
    // the forwarded signature verifies against the trigger's signing secret
    const verified = verifyGenericSignature(
      Buffer.from(call.body),
      { 'x-webhook-signature': call.headers['connect-signature'] },
      signingSecret,
    );
    expect(verified.valid).toBe(true);
    expect(JSON.parse(call.body).userId).toBe('u1');
  });

  it('rejects invalid signatures but keeps the event for debugging', async () => {
    const body = JSON.stringify({ type: 'evil.event' });
    const res = await h.app.request(`/v1/webhooks/${connectorId}/${ingestKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': 'sha256=bogus' },
      body,
    });
    expect(res.status).toBe(401);

    const events = await h.deps.db.query.webhookEvents.findMany({
      where: (t, { eq: e }) => e(t.connectorId, connectorId),
    });
    const evil = events.find((e) => (e.payload as { type?: string }).type === 'evil.event');
    expect(evil).toBeDefined();
    expect(evil!.signatureValid).toBe(false);
  });

  it('404s on a wrong ingest key', async () => {
    const res = await h.app.request(`/v1/webhooks/${connectorId}/wrong-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('deduplicates by provider delivery id', async () => {
    const first = await ingest({ type: 'dup.event' }, { 'x-webhook-id': 'dup-1' });
    expect((await json(first)).deliveries).toBe(1);
    const second = await ingest({ type: 'dup.event' }, { 'x-webhook-id': 'dup-1' });
    expect((await json(second)).deduplicated).toBe(true);
  });

  it('respects event filters', async () => {
    const filtered = await json(
      await h.app.request(
        `/v1/connectors/${connectorId}/triggers`,
        authed(org.pat, {
          name: 'only-orders',
          destinationUrl: 'https://consumer.test/orders',
          eventFilter: 'order.created',
        }),
      ),
    );
    const resNo = await ingest({ type: 'user.updated' }, { 'x-webhook-id': 'f-1' });
    // matches only the unfiltered trigger, not the order.created one
    expect((await json(resNo)).deliveries).toBe(1);

    const resYes = await ingest({ type: 'order.created' }, { 'x-webhook-id': 'f-2' });
    expect((await json(resYes)).deliveries).toBe(2);

    await h.app.request(`/v1/triggers/${filtered.trigger.id}`, {
      ...authed(org.pat),
      method: 'DELETE',
    });
  });

  it('marks failed deliveries and supports redelivery', async () => {
    destinationStatus = 503;
    const res = await ingest({ type: 'flaky.event' }, { 'x-webhook-id': 'flaky-1' });
    expect(res.status).toBe(200);

    const failing = await waitForDeliveries((rows) =>
      rows.some((r) => r.status === 'failed' && r.attempts >= 1),
    );
    const failed = failing.find((r) => r.status === 'failed')!;
    expect(failed.lastError).toContain('503');

    destinationStatus = 200;
    const redeliver = await h.app.request(`/v1/deliveries/${failed.id}/redeliver`, {
      ...authed(org.pat),
      method: 'POST',
    });
    expect(redeliver.status).toBe(200);
    await waitForDeliveries((rows) => rows.every((r) => r.status === 'succeeded'));

    const log = await json(
      await h.app.request(`/v1/triggers/${triggerId}/deliveries`, authed(org.pat)),
    );
    expect(log.deliveries.length).toBeGreaterThanOrEqual(2);
    expect(log.deliveries.every((d: { status: string }) => d.status === 'succeeded')).toBe(true);
  });

  it('inactive triggers receive nothing', async () => {
    await h.app.request(`/v1/triggers/${triggerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${org.pat}`, 'content-type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    const res = await ingest({ type: 'silent.event' }, { 'x-webhook-id': 's-1' });
    expect((await json(res)).deliveries).toBe(0);
  });
});
