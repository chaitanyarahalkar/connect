import { and, eq, isNull, ne } from 'drizzle-orm';
import { installationGrants, newId, type Db } from '@connect/db';
import { encryptSecret, secretAad, type KeyProvider } from '@connect/crypto';

type GrantType = (typeof installationGrants.$inferSelect)['grantType'];

/**
 * Stores a new grant as the current one, superseding any existing grant of the
 * same type. Old rows are kept (superseded_by_id set) for rotation forensics.
 */
export async function storeGrant(
  db: Db,
  kp: KeyProvider,
  installationId: string,
  grantType: GrantType,
  value: string,
  opts: { scopes?: string[]; expiresAt?: Date | null } = {},
): Promise<string> {
  const id = newId.grant();
  await db.transaction(async (tx) => {
    await tx.insert(installationGrants).values({
      id,
      installationId,
      grantType,
      ciphertext: encryptSecret(kp, secretAad('installation_grants', installationId, grantType), value),
      scopes: opts.scopes ?? [],
      expiresAt: opts.expiresAt ?? null,
    });
    await tx
      .update(installationGrants)
      .set({ supersededById: id, rotatedAt: new Date() })
      .where(
        and(
          eq(installationGrants.installationId, installationId),
          eq(installationGrants.grantType, grantType),
          isNull(installationGrants.supersededById),
          ne(installationGrants.id, id),
        ),
      );
  });
  return id;
}
