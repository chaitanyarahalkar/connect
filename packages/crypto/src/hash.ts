import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomToken(length = 32): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/**
 * Opaque bearer secrets (PATs, project client secrets, webhook ingest keys).
 * Only the SHA-256 hash is stored; the prefix is kept for lookup and display.
 */
export interface GeneratedSecret {
  /** Full plaintext, shown to the user exactly once. */
  plaintext: string;
  /** Hex SHA-256 of the plaintext, the only thing persisted. */
  hash: string;
  /** First 12 chars, safe to store and display ("cn_pat_a1b2…"). */
  prefix: string;
}

export function generateSecret(prefix: string, length = 32): GeneratedSecret {
  const plaintext = `${prefix}${randomToken(length)}`;
  return { plaintext, hash: hashSecret(plaintext), prefix: plaintext.slice(0, 12) };
}

export function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function verifySecret(plaintext: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(plaintext), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
