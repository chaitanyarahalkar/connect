/**
 * Master-key rotation job.
 *
 *   pnpm --filter @connect/api rotate-key
 *
 * KMS providers (CONNECT_KEY_PROVIDER=aws-kms|gcp-kms): mints a new KEK
 * version via the KMS, activates it, then re-wraps every stored DEK.
 *
 * Env provider: expects the operator to have added the new key to
 * CONNECT_MASTER_KEYS and pointed CONNECT_MASTER_KEY_VERSION at it; the job
 * then re-wraps every stored DEK to that version. Once the job reports zero
 * remaining uses of the old version, the old key can be dropped from the env.
 */
import { createDb } from '@connect/db';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createKeyProvider, createKmsClient } from '../src/keys/provider.js';
import { rewrapAllSecrets, rotateKmsMasterKey, versionsInUse } from '../src/keys/rotation.js';

loadDotEnv();
const config = loadConfig();
const { db, sql } = createDb(config.databaseUrl);

try {
  if (config.keyProvider === 'env') {
    console.log(
      `env key provider: re-wrapping to version ${config.masterKeyVersion} ` +
        '(add new keys via CONNECT_MASTER_KEYS + CONNECT_MASTER_KEY_VERSION)',
    );
  } else {
    const kms = createKmsClient(config);
    const { version } = await rotateKmsMasterKey(db, kms);
    console.log(`minted master key version ${version} via ${kms.provider}`);
  }

  const keyProvider = await createKeyProvider(config, db);
  const results = await rewrapAllSecrets(db, keyProvider);
  for (const r of results) {
    console.log(`${r.table}: re-wrapped ${r.rewrapped}/${r.scanned}`);
  }
  const inUse = await versionsInUse(db);
  console.log(`key versions still in use: ${[...inUse].sort().join(', ') || '(none)'}`);
} finally {
  await sql.end();
}
