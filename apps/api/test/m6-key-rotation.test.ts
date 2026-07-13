import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  decryptSecret,
  type EncryptedBlob,
  EnvKeyProvider,
  type KmsClient,
  secretAad,
} from '@connect/crypto';
import { connectorSecrets, masterKeys } from '@connect/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyProvider } from '../src/keys/provider.js';
import { rewrapAllSecrets, rotateKmsMasterKey, versionsInUse } from '../src/keys/rotation.js';
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

/** In-memory stand-in for AWS/GCP KMS: AES-GCM under a fixed local key. */
function fakeKms(): KmsClient {
  const key = randomBytes(32);
  return {
    provider: 'fake-kms',
    keyId: 'arn:fake:key/1',
    async encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]);
    },
    async decrypt(ciphertext) {
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    },
  };
}

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness();
  org = await seedOrg(h.deps);
});

afterAll(async () => {
  await h.cleanup();
});

describe('master-key rotation (env provider)', () => {
  it('re-wraps stored DEKs so a provider holding only the new key can decrypt', async () => {
    // a trigger adds a second encrypted table to the mix
    const trigRes = await h.app.request(
      `/v1/connectors/${org.apiKeyConnectorId}/triggers`,
      authed(org.pat, { name: 'rotation-test', destinationUrl: 'https://consumer.test/hook' }),
    );
    expect(trigRes.status).toBe(201);

    // tokens mint fine before rotation
    const before = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: org.apiKeyConnectorId }),
    );
    expect(before.status).toBe(200);

    const v2 = randomBytes(32).toString('base64');
    const rotated = new EnvKeyProvider({ v1: h.masterKey, v2 }, 'v2');
    const results = await rewrapAllSecrets(h.deps.db, rotated);
    // later tests in this file go through h, whose blobs are now on v2
    h.deps.keyProvider = rotated;

    const byTable = Object.fromEntries(results.map((r) => [r.table, r]));
    expect(byTable.connector_secrets!.rewrapped).toBeGreaterThan(0);
    expect(byTable.triggers!.rewrapped).toBeGreaterThan(0);
    // every scanned row (signing keys are created lazily, may be zero) is on v2
    expect(byTable.signing_keys!.rewrapped).toBe(byTable.signing_keys!.scanned);

    // nothing references v1 anymore, and a second run is a no-op
    expect(await versionsInUse(h.deps.db)).toEqual(new Set(['v2']));
    const again = await rewrapAllSecrets(h.deps.db, rotated);
    expect(again.every((r) => r.rewrapped === 0)).toBe(true);

    // a fresh app that only knows v2 can still serve tokens (stale cache entries
    // encrypted under v1 self-heal: decrypt fails -> cache miss -> re-mint)
    const v2Only = await createHarness({ keyProvider: new EnvKeyProvider({ v2 }, 'v2') });
    try {
      const res = await v2Only.app.request(
        '/v1/tokens',
        authed(org.pat, { connector: org.apiKeyConnectorId }),
      );
      expect(res.status).toBe(200);
      expect((await json(res)).token).toBe('secret-api-key-value');
    } finally {
      // shares the DB/redis with h; only close the extra clients
      await v2Only.cleanup();
    }
  });
});

describe('master-key rotation (KMS provider)', () => {
  it('bootstraps v1 in master_keys, rotates to v2, and re-wraps', async () => {
    const kms = fakeKms();
    const config = { ...h.deps.config, keyProvider: 'aws-kms' as const, kmsKeyId: kms.keyId };

    // first boot creates and persists v1
    const kp1 = await createKeyProvider(config, h.deps.db, kms);
    expect(kp1.keyVersion).toBe('v1');
    const stored = await h.deps.db.select().from(masterKeys);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ version: 'v1', provider: 'fake-kms', status: 'active' });

    // write a secret under v1
    const [secretRow] = await h.deps.db
      .select()
      .from(connectorSecrets)
      .where(eq(connectorSecrets.connectorId, org.apiKeyConnectorId));
    const aad = secretAad('connector_secrets', secretRow!.id, 'api_key');
    const plaintext = decryptSecret(
      h.deps.keyProvider,
      aad,
      secretRow!.ciphertext as EncryptedBlob,
    );
    const { encryptSecret } = await import('@connect/crypto');
    const blobV1 = encryptSecret(kp1, aad, plaintext);
    await h.deps.db
      .update(connectorSecrets)
      .set({ ciphertext: blobV1 })
      .where(eq(connectorSecrets.id, secretRow!.id));

    // rotate: v2 becomes active, v1 retired but still loadable
    const { version } = await rotateKmsMasterKey(h.deps.db, kms);
    expect(version).toBe('v2');
    const kp2 = await createKeyProvider(config, h.deps.db, kms);
    expect(kp2.keyVersion).toBe('v2');
    expect(decryptSecret(kp2, aad, blobV1)).toBe(plaintext);

    const results = await rewrapAllSecrets(h.deps.db, kp2);
    const secretsResult = results.find((r) => r.table === 'connector_secrets')!;
    expect(secretsResult.rewrapped).toBeGreaterThan(0);

    const [updated] = await h.deps.db
      .select()
      .from(connectorSecrets)
      .where(eq(connectorSecrets.id, secretRow!.id));
    expect((updated!.ciphertext as EncryptedBlob).keyVersion).toBe('v2');
    expect(decryptSecret(kp2, aad, updated!.ciphertext as EncryptedBlob)).toBe(plaintext);

    // restore the original blob so other suites' harness key still works
    await h.deps.db
      .update(connectorSecrets)
      .set({ ciphertext: secretRow!.ciphertext })
      .where(eq(connectorSecrets.id, secretRow!.id));
  });
});
