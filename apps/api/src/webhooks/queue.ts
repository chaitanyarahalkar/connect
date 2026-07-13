import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { triggers, webhookDeliveries, webhookEvents } from '@connect/db';
import { decryptSecret, secretAad, type EncryptedBlob } from '@connect/crypto';
import type { AppDeps } from '../deps.js';
import { meterUsage } from '../audit.js';
import { signForwardedPayload } from './verify.js';
import { logger } from '../logger.js';

export const DELIVERY_QUEUE = 'webhook-deliveries';
const MAX_ATTEMPTS = 5;

export interface DeliveryJob {
  deliveryId: string;
}

export const DELIVERY_JOB_OPTIONS: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export function createDeliveryQueue(redisUrl: string): Queue<DeliveryJob> {
  return new Queue(DELIVERY_QUEUE, {
    connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
  }) as Queue<DeliveryJob>;
}

/**
 * Delivery worker: POSTs the verified event to the trigger's destination,
 * signing the payload with the trigger's secret so receivers can verify that
 * the request came from Connect. Runs in the API process for the MVP.
 */
export function createDeliveryWorker(deps: AppDeps, opts: { concurrency?: number } = {}) {
  const worker = new Worker<DeliveryJob>(
    DELIVERY_QUEUE,
    async (job) => {
      const { deliveryId } = job.data;
      const [delivery] = await deps.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId))
        .limit(1);
      if (!delivery || delivery.status === 'succeeded') return;

      const [trigger] = await deps.db
        .select()
        .from(triggers)
        .where(eq(triggers.id, delivery.triggerId))
        .limit(1);
      const [event] = await deps.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, delivery.webhookEventId))
        .limit(1);
      if (!trigger || !event || !trigger.active) {
        await deps.db
          .update(webhookDeliveries)
          .set({ status: 'dead', lastError: 'trigger removed or disabled' })
          .where(eq(webhookDeliveries.id, deliveryId));
        return;
      }

      await deps.db
        .update(webhookDeliveries)
        .set({ status: 'delivering', attempts: delivery.attempts + 1 })
        .where(eq(webhookDeliveries.id, deliveryId));

      const payload = JSON.stringify(event.payload);
      const signingSecret = decryptSecret(
        deps.keyProvider,
        secretAad('triggers', trigger.id, 'signing_secret'),
        trigger.signingSecretCiphertext as EncryptedBlob,
      );

      let responseStatus: number | undefined;
      try {
        const res = await deps.providerFetch(trigger.destinationUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'connect-signature': signForwardedPayload(payload, signingSecret),
            'connect-event-id': event.id,
            'connect-event-type': event.providerEventType ?? 'unknown',
            'connect-connector': event.connectorId,
            'user-agent': 'connect-webhooks',
          },
          body: payload,
        });
        responseStatus = res.status;
        if (!res.ok) throw new Error(`destination responded ${res.status}`);
      } catch (err) {
        const isFinal = delivery.attempts + 1 >= MAX_ATTEMPTS;
        await deps.db
          .update(webhookDeliveries)
          .set({
            status: isFinal ? 'dead' : 'failed',
            responseStatus: responseStatus ?? null,
            lastError: String(err).slice(0, 500),
            nextRetryAt: isFinal ? null : new Date(Date.now() + 10_000 * 2 ** delivery.attempts),
          })
          .where(eq(webhookDeliveries.id, deliveryId));
        throw err; // let BullMQ schedule the retry
      }

      await deps.db
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          responseStatus,
          deliveredAt: new Date(),
          lastError: null,
          nextRetryAt: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));

      const orgId = await orgIdForConnector(deps, event.connectorId);
      if (orgId) {
        await meterUsage(deps.db, { orgId, connectorId: event.connectorId, kind: 'webhook_delivery' });
      }
    },
    {
      connection: new Redis(deps.config.redisUrl, { maxRetriesPerRequest: null }),
      concurrency: opts.concurrency ?? 5,
    },
  );
  worker.on('failed', (job, err) => {
    logger.warn({ deliveryId: job?.data.deliveryId, err: err.message }, 'webhook delivery attempt failed');
  });
  return worker;
}

async function orgIdForConnector(deps: AppDeps, connectorId: string): Promise<string | null> {
  const row = await deps.db.query.connectors.findFirst({
    where: (t, { eq: e }) => e(t.id, connectorId),
    columns: { orgId: true },
  });
  return row?.orgId ?? null;
}
