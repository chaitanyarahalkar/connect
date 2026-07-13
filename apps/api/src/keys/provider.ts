import { readFileSync } from 'node:fs';
import {
  AwsKmsClient,
  EnvKeyProvider,
  GcpKmsClient,
  type KeyProvider,
  type KmsClient,
  KmsKeyProvider,
} from '@connect/crypto';
import { type Db, masterKeys } from '@connect/db';
import { asc } from 'drizzle-orm';
import type { ApiConfig } from '../config.js';

/** Builds the KMS client selected by CONNECT_KEY_PROVIDER. */
export function createKmsClient(
  config: ApiConfig,
  env: NodeJS.ProcessEnv = process.env,
): KmsClient {
  const keyId = config.kmsKeyId;
  if (!keyId) throw new Error('CONNECT_KMS_KEY_ID is not set');
  if (config.keyProvider === 'aws-kms') return AwsKmsClient.fromEnv(keyId, env);
  if (config.keyProvider === 'gcp-kms') {
    const inline = env.GCP_SERVICE_ACCOUNT_JSON;
    const path = env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!inline && !path) {
      throw new Error('set GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS for gcp-kms');
    }
    const json = JSON.parse(inline ?? readFileSync(path!, 'utf8')) as Record<string, unknown>;
    return GcpKmsClient.fromServiceAccountJson(keyId, json);
  }
  throw new Error(`key provider ${config.keyProvider} has no KMS client`);
}

/**
 * Resolves the app-wide KeyProvider. The env provider is synchronous config;
 * KMS providers load (and on first boot, create) their KEK versions from the
 * master_keys table, costing one KMS Decrypt per stored version at startup.
 */
export async function createKeyProvider(
  config: ApiConfig,
  db: Db,
  kmsOverride?: KmsClient,
): Promise<KeyProvider> {
  if (config.keyProvider === 'env') {
    return new EnvKeyProvider(config.masterKeys, config.masterKeyVersion);
  }
  const kms = kmsOverride ?? createKmsClient(config);
  let rows = await db.select().from(masterKeys).orderBy(asc(masterKeys.createdAt));
  if (rows.length === 0) {
    const { wrappedKek } = await KmsKeyProvider.generateKek(kms);
    rows = await db
      .insert(masterKeys)
      .values({ version: 'v1', provider: kms.provider, kmsKeyId: kms.keyId, wrappedKek })
      .returning();
  }
  const active = rows.filter((r) => r.status === 'active');
  if (active.length === 0) throw new Error('no active master key version');
  const current = active[active.length - 1]!.version;
  return KmsKeyProvider.load(kms, rows, current);
}
