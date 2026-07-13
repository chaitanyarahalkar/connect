import { randomBytes } from 'node:crypto';
import { KekChain } from '../envelope.js';
import type { KmsClient } from './types.js';

/**
 * KeyProvider backed by a remote KMS. The KEKs themselves are random 32-byte
 * keys generated locally, wrapped by the KMS key, and persisted (master_keys
 * table). At boot each stored version is decrypted with one KMS call; DEK
 * wrapping then happens locally, so the KMS is never on the hot path of a
 * token mint. Rotation = generate a new KEK version + re-wrap stored DEKs.
 */

export interface StoredKekVersion {
  version: string;
  /** base64 of the KMS-wrapped KEK. */
  wrappedKek: string;
}

export class KmsKeyProvider extends KekChain {
  private constructor(keys: Record<string, Buffer>, current: string) {
    super(keys, current);
  }

  /** Decrypts every stored KEK version via the KMS and wraps new DEKs under `current`. */
  static async load(
    kms: KmsClient,
    versions: StoredKekVersion[],
    current: string,
  ): Promise<KmsKeyProvider> {
    if (versions.length === 0) throw new Error('no master key versions to load');
    const keys: Record<string, Buffer> = {};
    for (const v of versions) {
      keys[v.version] = await kms.decrypt(Buffer.from(v.wrappedKek, 'base64'));
    }
    return new KmsKeyProvider(keys, current);
  }

  /** Generates a fresh KEK and returns its KMS-wrapped form for persistence. */
  static async generateKek(kms: KmsClient): Promise<{ wrappedKek: string }> {
    const kek = randomBytes(32);
    try {
      return { wrappedKek: (await kms.encrypt(kek)).toString('base64') };
    } finally {
      kek.fill(0);
    }
  }
}
