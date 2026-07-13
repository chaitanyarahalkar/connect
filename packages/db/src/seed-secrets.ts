import { eq, and } from 'drizzle-orm';
import type { Db } from './client.js';
import { newId } from './ids.js';
import { connectorSecrets } from './schema.js';
import { encryptSecret, secretAad, type KeyProvider } from '@connect/crypto';

type SecretKind = (typeof connectorSecrets.$inferSelect)['kind'];

/** Seed-time variant of the API's storeConnectorSecret (kept dependency-free of apps/api). */
export async function storeSeedSecret(
  db: Db,
  kp: KeyProvider,
  connectorId: string,
  kind: SecretKind,
  value: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: connectorSecrets.id })
    .from(connectorSecrets)
    .where(and(eq(connectorSecrets.connectorId, connectorId), eq(connectorSecrets.kind, kind)))
    .limit(1);
  if (existing) {
    await db
      .update(connectorSecrets)
      .set({ ciphertext: encryptSecret(kp, secretAad('connector_secrets', existing.id, kind), value) })
      .where(eq(connectorSecrets.id, existing.id));
    return;
  }
  const id = newId.connectorSecret();
  await db.insert(connectorSecrets).values({
    id,
    connectorId,
    kind,
    ciphertext: encryptSecret(kp, secretAad('connector_secrets', id, kind), value),
  });
}
