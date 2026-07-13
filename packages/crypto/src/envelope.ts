import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets at rest.
 *
 * Each secret gets its own random 32-byte DEK. The plaintext is encrypted with
 * AES-256-GCM under the DEK, with AAD binding the ciphertext to its logical
 * location (`table:rowId:kind`) so an attacker with DB write access cannot swap
 * ciphertexts between rows. The DEK is then wrapped (AES-256-GCM) by a KEK
 * obtained from a KeyProvider — an env-var master key in the MVP, a KMS later.
 */

export interface EncryptedBlob {
  v: 1;
  alg: 'A256GCM';
  /** base64: 12-byte IV for the data encryption */
  iv: string;
  /** base64: 16-byte GCM tag for the data encryption */
  tag: string;
  /** base64: ciphertext */
  data: string;
  /** base64: wrapped DEK (iv || tag || ciphertext) */
  wrappedDek: string;
  keyVersion: string;
}

export interface KeyProvider {
  keyVersion: string;
  wrapDek(dek: Buffer): Buffer;
  unwrapDek(wrapped: Buffer, keyVersion: string): Buffer;
}

/** KEK from a base64-encoded 32-byte env value (CONNECT_MASTER_KEY). */
export class EnvKeyProvider implements KeyProvider {
  private keys: Map<string, Buffer>;
  keyVersion: string;

  /**
   * @param keys map of version -> base64 key. `current` names the version used
   * for new wraps; older versions remain available for unwrapping.
   */
  constructor(keys: Record<string, string>, current: string) {
    this.keys = new Map();
    for (const [version, b64] of Object.entries(keys)) {
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) {
        throw new Error(`master key "${version}" must be 32 bytes (base64), got ${key.length}`);
      }
      this.keys.set(version, key);
    }
    if (!this.keys.has(current)) throw new Error(`current key version "${current}" not provided`);
    this.keyVersion = current;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EnvKeyProvider {
    const key = env.CONNECT_MASTER_KEY;
    if (!key) throw new Error('CONNECT_MASTER_KEY is not set');
    return new EnvKeyProvider({ v1: key }, 'v1');
  }

  private key(version: string): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`unknown key version "${version}"`);
    return k;
  }

  wrapDek(dek: Buffer): Buffer {
    const kek = this.key(this.keyVersion);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  unwrapDek(wrapped: Buffer, keyVersion: string): Buffer {
    const kek = this.key(keyVersion);
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/** AAD binds a ciphertext to its row: encryptSecret(kp, 'connector_secrets:cs_123:api_key', ...) */
export function encryptSecret(kp: KeyProvider, aad: string, plaintext: string): EncryptedBlob {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const blob: EncryptedBlob = {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    wrappedDek: kp.wrapDek(dek).toString('base64'),
    keyVersion: kp.keyVersion,
  };
  dek.fill(0);
  return blob;
}

export function decryptSecret(kp: KeyProvider, aad: string, blob: EncryptedBlob): string {
  if (blob.v !== 1 || blob.alg !== 'A256GCM') {
    throw new Error(`unsupported blob version/alg: ${blob.v}/${blob.alg}`);
  }
  const dek = kp.unwrapDek(Buffer.from(blob.wrappedDek, 'base64'), blob.keyVersion);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(blob.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(blob.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

export function secretAad(table: string, rowId: string, kind: string): string {
  return `${table}:${rowId}:${kind}`;
}
