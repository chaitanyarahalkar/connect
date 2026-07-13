import { encryptSecret, type KeyProvider, secretAad } from '@connect/crypto';
import { connectorSecrets, type Db, newId } from '@connect/db';
import { and, eq } from 'drizzle-orm';

type SecretKind = (typeof connectorSecrets.$inferSelect)['kind'];

/** Upserts an envelope-encrypted connector secret. Write-only: never read back via API. */
export async function storeConnectorSecret(
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
      .set({
        ciphertext: encryptSecret(kp, secretAad('connector_secrets', existing.id, kind), value),
        updatedAt: new Date(),
      })
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
