import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { connectors, newId, triggers, webhookDeliveries, webhookEvents } from '@connect/db';
import { encryptSecret, randomToken, secretAad } from '@connect/crypto';
import { ConnectError } from '@connect/shared';
import type { Queue } from 'bullmq';
import type { AppDeps } from '../deps.js';
import { requireRole, type AuthEnv } from '../auth/middleware.js';
import { writeAudit } from '../audit.js';
import { findConnector } from './connectors.js';
import { DELIVERY_JOB_OPTIONS, type DeliveryJob } from '../webhooks/queue.js';

/** Trigger CRUD nested under connectors. */
export function connectorTriggerRoutes(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.get('/:id/triggers', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const connector = await findConnector(deps, principal.orgId, c.req.param('id'));
    const rows = await deps.db
      .select({
        id: triggers.id,
        name: triggers.name,
        destinationUrl: triggers.destinationUrl,
        eventFilter: triggers.eventFilter,
        active: triggers.active,
        createdAt: triggers.createdAt,
      })
      .from(triggers)
      .where(eq(triggers.connectorId, connector.id))
      .orderBy(desc(triggers.createdAt));
    return c.json({ triggers: rows });
  });

  app.post(
    '/:id/triggers',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120),
        destinationUrl: z.string().url(),
        eventFilter: z.string().min(1).optional(),
      }),
    ),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const connector = await findConnector(deps, principal.orgId, c.req.param('id'));
      const input = c.req.valid('json');
      const id = newId.trigger();
      const signingSecret = `whsec_${randomToken(32)}`;
      await deps.db.insert(triggers).values({
        id,
        connectorId: connector.id,
        name: input.name,
        destinationUrl: input.destinationUrl,
        eventFilter: input.eventFilter ?? null,
        signingSecretCiphertext: encryptSecret(
          deps.keyProvider,
          secretAad('triggers', id, 'signing_secret'),
          signingSecret,
        ),
      });
      await writeAudit(deps.db, principal, {
        orgId: principal.orgId,
        action: 'trigger.create',
        targetType: 'trigger',
        targetId: id,
        metadata: { connector: connector.slug, destinationUrl: input.destinationUrl },
      });
      // signing secret is returned exactly once
      return c.json(
        {
          trigger: {
            id,
            name: input.name,
            destinationUrl: input.destinationUrl,
            eventFilter: input.eventFilter ?? null,
            active: true,
            signingSecret,
          },
        },
        201,
      );
    },
  );

  return app;
}

/** Flat trigger/delivery routes. */
export function triggerRoutes(deps: AppDeps, queue: Queue<DeliveryJob>) {
  const app = new Hono<AuthEnv>();

  app.patch(
    '/:id',
    zValidator('json', z.object({ active: z.boolean().optional(), name: z.string().optional() })),
    async (c) => {
      const principal = c.get('principal');
      requireRole(principal, 'admin');
      const trigger = await findTrigger(deps, principal.orgId, c.req.param('id'));
      const input = c.req.valid('json');
      const [row] = await deps.db
        .update(triggers)
        .set({
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.name ? { name: input.name } : {}),
        })
        .where(eq(triggers.id, trigger.id))
        .returning();
      return c.json({ trigger: { id: row!.id, active: row!.active, name: row!.name } });
    },
  );

  app.delete('/:id', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const trigger = await findTrigger(deps, principal.orgId, c.req.param('id'));
    await deps.db.delete(triggers).where(eq(triggers.id, trigger.id));
    await writeAudit(deps.db, principal, {
      orgId: principal.orgId,
      action: 'trigger.delete',
      targetType: 'trigger',
      targetId: trigger.id,
    });
    return c.json({ ok: true });
  });

  app.get('/:id/deliveries', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'member');
    const trigger = await findTrigger(deps, principal.orgId, c.req.param('id'));
    const rows = await deps.db
      .select({
        id: webhookDeliveries.id,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        responseStatus: webhookDeliveries.responseStatus,
        lastError: webhookDeliveries.lastError,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
        eventType: webhookEvents.providerEventType,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.webhookEventId))
      .where(eq(webhookDeliveries.triggerId, trigger.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(100);
    return c.json({ deliveries: rows });
  });

  return app;
}

export function deliveryRoutes(deps: AppDeps, queue: Queue<DeliveryJob>) {
  const app = new Hono<AuthEnv>();

  app.post('/:id/redeliver', async (c) => {
    const principal = c.get('principal');
    requireRole(principal, 'admin');
    const [delivery] = await deps.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, c.req.param('id')))
      .limit(1);
    if (!delivery) throw new ConnectError('not_found', 'delivery not found');
    await findTrigger(deps, principal.orgId, delivery.triggerId); // org check
    await deps.db
      .update(webhookDeliveries)
      .set({ status: 'pending', attempts: 0, lastError: null })
      .where(eq(webhookDeliveries.id, delivery.id));
    await queue.add('deliver', { deliveryId: delivery.id }, DELIVERY_JOB_OPTIONS);
    return c.json({ ok: true });
  });

  return app;
}

async function findTrigger(deps: AppDeps, orgId: string, triggerId: string) {
  const [row] = await deps.db
    .select({ trigger: triggers, orgId: connectors.orgId })
    .from(triggers)
    .innerJoin(connectors, eq(connectors.id, triggers.connectorId))
    .where(eq(triggers.id, triggerId))
    .limit(1);
  if (!row || row.orgId !== orgId) throw new ConnectError('not_found', 'trigger not found');
  return row.trigger;
}
