import {
  type EncryptedBlob,
  type KeyProvider,
  type KmsClient,
  KmsKeyProvider,
  rewrapSecret,
} from '@connect/crypto';
import {
  connectorSecrets,
  type Db,
  installationGrants,
  masterKeys,
  signingKeys,
  triggers,
} from '@connect/db';
import { eq } from 'drizzle-orm';

/**
 * Master-key rotation. Two halves:
 *  1. Introduce a new KEK version — for KMS providers `rotateKmsMasterKey`
 *     mints and persists it; for the env provider the operator adds a key to
 *     CONNECT_MASTER_KEYS and bumps CONNECT_MASTER_KEY_VERSION.
 *  2. `rewrapAllSecrets` walks every stored EncryptedBlob and re-wraps its DEK
 *     under the current version. Data ciphertexts are untouched, so this is
 *     cheap and idempotent — safe to re-run until it reports zero re-wraps.
 */

/** Creates and activates a new KMS-wrapped KEK version; older versions are retired. */
export async function rotateKmsMasterKey(db: Db, kms: KmsClient): Promise<{ version: string }> {
  const rows = await db.select({ version: masterKeys.version }).from(masterKeys);
  const max = rows.reduce((n, r) => Math.max(n, Number(r.version.replace(/^v/, '')) || 0), 0);
  const version = `v${max + 1}`;
  const { wrappedKek } = await KmsKeyProvider.generateKek(kms);
  await db.transaction(async (tx) => {
    await tx
      .update(masterKeys)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(masterKeys.status, 'active'));
    await tx
      .insert(masterKeys)
      .values({ version, provider: kms.provider, kmsKeyId: kms.keyId, wrappedKek });
  });
  return { version };
}

export interface RewrapResult {
  table: string;
  scanned: number;
  rewrapped: number;
}

interface RewrapTarget {
  table: string;
  list(): Promise<{ id: string; blob: unknown }[]>;
  update(id: string, blob: EncryptedBlob): Promise<void>;
}

/** Re-wraps every stored DEK to the provider's current key version. */
export async function rewrapAllSecrets(db: Db, kp: KeyProvider): Promise<RewrapResult[]> {
  const targets: RewrapTarget[] = [
    {
      table: 'connector_secrets',
      list: () =>
        db
          .select({ id: connectorSecrets.id, blob: connectorSecrets.ciphertext })
          .from(connectorSecrets),
      update: async (id, blob) => {
        await db
          .update(connectorSecrets)
          .set({ ciphertext: blob, updatedAt: new Date() })
          .where(eq(connectorSecrets.id, id));
      },
    },
    {
      table: 'installation_grants',
      list: () =>
        db
          .select({ id: installationGrants.id, blob: installationGrants.ciphertext })
          .from(installationGrants),
      update: async (id, blob) => {
        await db
          .update(installationGrants)
          .set({ ciphertext: blob })
          .where(eq(installationGrants.id, id));
      },
    },
    {
      table: 'triggers',
      list: () =>
        db.select({ id: triggers.id, blob: triggers.signingSecretCiphertext }).from(triggers),
      update: async (id, blob) => {
        await db.update(triggers).set({ signingSecretCiphertext: blob }).where(eq(triggers.id, id));
      },
    },
    {
      table: 'signing_keys',
      list: () =>
        db.select({ id: signingKeys.id, blob: signingKeys.privateKeyCiphertext }).from(signingKeys),
      update: async (id, blob) => {
        await db
          .update(signingKeys)
          .set({ privateKeyCiphertext: blob })
          .where(eq(signingKeys.id, id));
      },
    },
  ];

  const results: RewrapResult[] = [];
  for (const target of targets) {
    const rows = await target.list();
    let rewrapped = 0;
    for (const row of rows) {
      const blob = row.blob as EncryptedBlob;
      if (blob.keyVersion === kp.keyVersion) continue;
      await target.update(row.id, rewrapSecret(kp, blob));
      rewrapped++;
    }
    results.push({ table: target.table, scanned: rows.length, rewrapped });
  }
  return results;
}

/** Versions still referenced by at least one stored blob (must stay decryptable). */
export async function versionsInUse(db: Db): Promise<Set<string>> {
  const versions = new Set<string>();
  const collect = (rows: { blob: unknown }[]) => {
    for (const r of rows) versions.add((r.blob as EncryptedBlob).keyVersion);
  };
  collect(await db.select({ blob: connectorSecrets.ciphertext }).from(connectorSecrets));
  collect(await db.select({ blob: installationGrants.ciphertext }).from(installationGrants));
  collect(await db.select({ blob: triggers.signingSecretCiphertext }).from(triggers));
  collect(await db.select({ blob: signingKeys.privateKeyCiphertext }).from(signingKeys));
  return versions;
}
