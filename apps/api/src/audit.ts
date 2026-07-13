import { auditLogs, newId, usageEvents, type Db } from '@connect/db';
import { redact } from '@connect/shared';
import type { Principal } from './auth/principal.js';

export async function writeAudit(
  db: Db,
  principal: Principal | null,
  entry: {
    orgId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLogs).values({
    id: newId.audit(),
    orgId: entry.orgId,
    actorType: principal?.kind ?? 'system',
    actorId: principal?.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ? redact(entry.metadata) : null,
  });
}

export async function meterUsage(
  db: Db,
  entry: {
    orgId: string;
    projectId?: string | null;
    connectorId?: string | null;
    kind: 'token_request' | 'webhook_delivery';
    quantity?: number;
  },
): Promise<void> {
  await db.insert(usageEvents).values({
    id: newId.usage(),
    orgId: entry.orgId,
    projectId: entry.projectId ?? null,
    connectorId: entry.connectorId ?? null,
    kind: entry.kind,
    quantity: entry.quantity ?? 1,
  });
}
