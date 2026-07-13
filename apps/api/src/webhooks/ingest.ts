import { timingSafeEqual } from 'node:crypto';
import { connectors, newId, triggers, webhookDeliveries, webhookEvents } from '@connect/db';
import { redact } from '@connect/shared';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { isUniqueViolation } from '../db-errors.js';
import type { AppDeps } from '../deps.js';
import { logger } from '../logger.js';
import { readConnectorSecret } from '../tokens/minters.js';
import { DELIVERY_JOB_OPTIONS, type DeliveryJob } from './queue.js';
import {
  type VerificationResult,
  verifyGenericSignature,
  verifyGithubSignature,
  verifySlackSignature,
} from './verify.js';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Public webhook intake. The URL path carries a per-connector random ingest
 * key; the payload signature is verified against the connector's stored
 * secret before anything is queued.
 */
export function webhookIngestRoutes(deps: AppDeps, queue: Queue<DeliveryJob>) {
  const app = new Hono();

  app.post('/v1/webhooks/:connectorId/:ingestKey', async (c) => {
    const [connector] = await deps.db
      .select()
      .from(connectors)
      .where(eq(connectors.id, c.req.param('connectorId')))
      .limit(1);
    if (!connector || !safeEqual(connector.ingestKey, c.req.param('ingestKey'))) {
      return c.json({ error: { code: 'not_found', message: 'unknown intake' } }, 404);
    }

    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    const verification = await verifyByType(deps, connector, rawBody, headers);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return c.json({ error: { code: 'validation_error', message: 'body must be JSON' } }, 400);
    }

    // Slack URL verification handshake must be answered even before triggers exist.
    if (connector.type === 'slack' && payload.type === 'url_verification') {
      if (!verification.valid) return c.json({ error: { code: 'unauthorized' } }, 401);
      return c.json({ challenge: payload.challenge });
    }

    const eventType = extractEventType(connector.type, payload, headers);
    const dedupKey =
      headers['x-github-delivery'] ??
      headers['x-slack-request-timestamp'] ??
      headers['x-mock-delivery'] ??
      headers['x-webhook-id'] ??
      null;

    const eventId = newId.webhookEvent();
    try {
      await deps.db.insert(webhookEvents).values({
        id: eventId,
        connectorId: connector.id,
        providerEventType: eventType,
        signatureValid: verification.valid,
        dedupKey,
        payload,
        headers: redact(headers),
      });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ ok: true, deduplicated: true });
      throw err;
    }

    if (!verification.valid) {
      // stored for debugging, never forwarded
      logger.warn(
        { connector: connector.slug, reason: verification.reason },
        'webhook signature invalid',
      );
      return c.json({ error: { code: 'unauthorized', message: verification.reason } }, 401);
    }

    const destinations = await deps.db
      .select()
      .from(triggers)
      .where(and(eq(triggers.connectorId, connector.id), eq(triggers.active, true)));
    const matching = destinations.filter((t) => !t.eventFilter || t.eventFilter === eventType);

    for (const trigger of matching) {
      const deliveryId = newId.delivery();
      await deps.db.insert(webhookDeliveries).values({
        id: deliveryId,
        webhookEventId: eventId,
        triggerId: trigger.id,
        status: 'pending',
      });
      await queue.add('deliver', { deliveryId }, DELIVERY_JOB_OPTIONS);
    }

    return c.json({ ok: true, eventId, deliveries: matching.length });
  });

  return app;
}

async function verifyByType(
  deps: AppDeps,
  connector: typeof connectors.$inferSelect,
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
): Promise<VerificationResult> {
  if (connector.type === 'github') {
    const secret = await readConnectorSecret(
      deps.db,
      deps.keyProvider,
      connector.id,
      'webhook_secret',
    );
    if (!secret) return { valid: false, reason: 'no webhook secret configured' };
    return verifyGithubSignature(rawBody, headers, secret);
  }
  if (connector.type === 'slack') {
    const secret = await readConnectorSecret(
      deps.db,
      deps.keyProvider,
      connector.id,
      'slack_signing_secret',
    );
    if (!secret) return { valid: false, reason: 'no signing secret configured' };
    return verifySlackSignature(rawBody, headers, secret);
  }
  const secret = await readConnectorSecret(
    deps.db,
    deps.keyProvider,
    connector.id,
    'webhook_secret',
  );
  if (!secret) return { valid: false, reason: 'no webhook secret configured' };
  return verifyGenericSignature(rawBody, headers, secret);
}

function extractEventType(
  type: string,
  payload: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): string | null {
  if (type === 'github') return headers['x-github-event'] ?? null;
  if (type === 'slack') {
    const event = payload.event as Record<string, unknown> | undefined;
    return String(event?.type ?? payload.type ?? '') || null;
  }
  return headers['x-mock-event'] ?? (typeof payload.type === 'string' ? payload.type : null);
}
