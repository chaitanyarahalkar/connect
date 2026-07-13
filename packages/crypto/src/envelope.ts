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

/**
 * Base for providers that hold KEK bytes in memory, keyed by version. DEKs are
 * wrapped locally with AES-256-GCM; subclasses differ only in where the KEK
 * bytes come from (env vars, a KMS-decrypted blob, …).
 */
export class KekChain implements KeyProvider {
  protected keys: Map<string, Buffer>;
  keyVersion: string;

  /**
   * @param keys map of version -> 32-byte KEK. `current` names the version used
   * for new wraps; older versions remain available for unwrapping.
   */
  constructor(keys: Record<string, Buffer>, current: string) {
    this.keys = new Map();
    for (const [version, key] of Object.entries(keys)) {
      if (key.length !== 32) {
        throw new Error(`master key "${version}" must be 32 bytes, got ${key.length}`);
      }
      this.keys.set(version, key);
    }
    if (!this.keys.has(current)) throw new Error(`current key version "${current}" not provided`);
    this.keyVersion = current;
  }

  /** Versions this provider can unwrap. */
  get versions(): string[] {
    return [...this.keys.keys()];
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

/** KEK from base64-encoded 32-byte env values (CONNECT_MASTER_KEY[S]). */
export class EnvKeyProvider extends KekChain {
  /** @param keys map of version -> base64 key. */
  constructor(keys: Record<string, string>, current: string) {
    const decoded: Record<string, Buffer> = {};
    for (const [version, b64] of Object.entries(keys)) {
      decoded[version] = Buffer.from(b64, 'base64');
    }
    super(decoded, current);
  }

  /**
   * Reads CONNECT_MASTER_KEY (always version "v1"). Additional versions may be
   * supplied via CONNECT_MASTER_KEYS (JSON: {"v2":"<base64>"}); the wrap
   * version defaults to v1 and is overridden by CONNECT_MASTER_KEY_VERSION.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): EnvKeyProvider {
    const key = env.CONNECT_MASTER_KEY;
    if (!key) throw new Error('CONNECT_MASTER_KEY is not set');
    const extra = env.CONNECT_MASTER_KEYS
      ? (JSON.parse(env.CONNECT_MASTER_KEYS) as Record<string, string>)
      : {};
    return new EnvKeyProvider({ v1: key, ...extra }, env.CONNECT_MASTER_KEY_VERSION ?? 'v1');
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

/**
 * Re-wraps a blob's DEK under the provider's current KEK. The data ciphertext
 * (and therefore the plaintext) is untouched — master-key rotation only needs
 * to unwrap the DEK with the old version and wrap it with the new one.
 */
export function rewrapSecret(kp: KeyProvider, blob: EncryptedBlob): EncryptedBlob {
  if (blob.keyVersion === kp.keyVersion) return blob;
  const dek = kp.unwrapDek(Buffer.from(blob.wrappedDek, 'base64'), blob.keyVersion);
  try {
    return { ...blob, wrappedDek: kp.wrapDek(dek).toString('base64'), keyVersion: kp.keyVersion };
  } finally {
    dek.fill(0);
  }
}
