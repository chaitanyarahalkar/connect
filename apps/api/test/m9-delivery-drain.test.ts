import { createHmac } from 'node:crypto';
import { webhookDeliveries } from '@connect/db';
import type { Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeliveryWorker } from '../src/webhooks/queue.js';
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

const WEBHOOK_SECRET = 'drain-webhook-secret';
let destinationStatus = 200;
const destinationFetch: typeof fetch = (async (input: unknown) => {
  if (String(input).startsWith('https://consumer.test/')) {
    return new Response('ok', { status: destinationStatus });
  }
  throw new Error(`unexpected outbound fetch to ${String(input)}`);
}) as typeof fetch;

function ingest(payload: Record<string, unknown>, id: string) {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  return h.app.request(`/v1/webhooks/${connectorId}/${ingestKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sig,
      'x-webhook-id': id,
    },
    body,
  });
}

async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness({ providerFetch: destinationFetch });
  org = await seedOrg(h.deps);

  const created = await json(
    await h.app.request(
      '/v1/connectors',
      authed(org.pat, {
        slug: 'drain-svc',
        name: 'Drain Service',
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
      authed(org.pat, { name: 'drain-dest', destinationUrl: 'https://consumer.test/drain' }),
    ),
  );
  triggerId = trig.trigger.id;
});

afterAll(async () => {
  await worker?.close();
  await h.cleanup();
});

describe('delivery detail + dead-letter drain', () => {
  it('accumulates dead-letter deliveries', async () => {
    // ingest three events without a worker running, then mark them dead to
    // simulate deliveries that exhausted their retries
    for (const id of ['d-1', 'd-2', 'd-3']) {
      const res = await ingest({ type: 'order.created', id }, id);
      expect(res.status).toBe(200);
    }
    const rows = await h.deps.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.triggerId, triggerId));
    expect(rows).toHaveLength(3);
    await h.deps.db
      .update(webhookDeliveries)
      .set({ status: 'dead', attempts: 5, lastError: 'destination responded 503' })
      .where(
        inArray(
          webhookDeliveries.id,
          rows.map((r) => r.id),
        ),
      );
  });

  it('filters the delivery log by status', async () => {
    const dead = await json(
      await h.app.request(`/v1/triggers/${triggerId}/deliveries?status=dead`, authed(org.pat)),
    );
    expect(dead.deliveries).toHaveLength(3);
    const ok = await json(
      await h.app.request(`/v1/triggers/${triggerId}/deliveries?status=succeeded`, authed(org.pat)),
    );
    expect(ok.deliveries).toHaveLength(0);
  });

  it('exposes full delivery detail including the event payload', async () => {
    const list = await json(
      await h.app.request(`/v1/triggers/${triggerId}/deliveries`, authed(org.pat)),
    );
    const res = await h.app.request(`/v1/deliveries/${list.deliveries[0].id}`, authed(org.pat));
    expect(res.status).toBe(200);
    const { delivery } = await json(res);
    expect(delivery.trigger).toMatchObject({ id: triggerId, name: 'drain-dest' });
    expect(delivery.destinationUrl).toBe('https://consumer.test/drain');
    expect(delivery.event.signatureValid).toBe(true);
    expect(delivery.event.payload.type).toBe('order.created');
    expect(delivery.lastError).toContain('503');
  });

  it('drains all dead deliveries back through the queue', async () => {
    destinationStatus = 200;
    worker = createDeliveryWorker(h.deps, { concurrency: 2 });

    const res = await h.app.request(`/v1/triggers/${triggerId}/drain`, {
      ...authed(org.pat),
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await json(res)).drained).toBe(3);

    await waitFor(async () => {
      const rows = await h.deps.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.triggerId, triggerId));
      return rows.every((r) => r.status === 'succeeded');
    });
  });

  it('is a no-op when nothing is dead', async () => {
    const res = await h.app.request(`/v1/triggers/${triggerId}/drain`, {
      ...authed(org.pat),
      method: 'POST',
    });
    expect((await json(res)).drained).toBe(0);
  });

  it('hides deliveries from other orgs', async () => {
    const stranger = await seedOrg(h.deps, 'stranger');
    const list = await json(
      await h.app.request(`/v1/triggers/${triggerId}/deliveries`, authed(org.pat)),
    );
    const detail = await h.app.request(
      `/v1/deliveries/${list.deliveries[0].id}`,
      authed(stranger.pat),
    );
    expect(detail.status).toBe(404);
    const drain = await h.app.request(`/v1/triggers/${triggerId}/drain`, {
      ...authed(stranger.pat),
      method: 'POST',
    });
    expect(drain.status).toBe(404);
  });
});
