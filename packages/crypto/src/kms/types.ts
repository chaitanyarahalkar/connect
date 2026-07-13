/**
 * Minimal remote-KMS surface: wrap/unwrap a 32-byte KEK. Providers (AWS, GCP)
 * implement this over their REST APIs with an injected fetch, so the rest of
 * the crypto package — and all tests — stay network-free.
 */
export interface KmsClient {
  /** Stored on master_keys rows so ciphertexts are traceable ('aws-kms', 'gcp-kms'). */
  readonly provider: string;
  /** The remote key identifier (ARN / resource name) used for wrapping. */
  readonly keyId: string;
  /** Encrypts KEK bytes under the remote KMS key. */
  encrypt(plaintext: Buffer): Promise<Buffer>;
  /** Decrypts a KMS-wrapped KEK. */
  decrypt(ciphertext: Buffer): Promise<Buffer>;
}

export class KmsError extends Error {
  constructor(
    public provider: string,
    public operation: 'encrypt' | 'decrypt' | 'auth',
    message: string,
  ) {
    super(`${provider} ${operation} failed: ${message}`);
    this.name = 'KmsError';
  }
}
