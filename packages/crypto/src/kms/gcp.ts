import { importPKCS8, SignJWT } from 'jose';
import { type KmsClient, KmsError } from './types.js';

/**
 * Google Cloud KMS over its REST API, authenticated with a service-account
 * JWT-bearer exchange (jose is already a dependency) — no google-cloud SDK.
 */

export interface GcpServiceAccount {
  /** `client_email` from the service-account JSON key file. */
  clientEmail: string;
  /** `private_key` (PKCS#8 PEM) from the service-account JSON key file. */
  privateKeyPem: string;
}

export interface GcpKmsClientOptions {
  /** Full resource name: projects/P/locations/L/keyRings/R/cryptoKeys/K */
  keyName: string;
  serviceAccount: GcpServiceAccount;
  fetchImpl?: typeof fetch;
  /** Override API/token endpoints (tests). */
  apiBase?: string;
  tokenUrl?: string;
}

const CLOUDKMS_SCOPE = 'https://www.googleapis.com/auth/cloudkms';

export class GcpKmsClient implements KmsClient {
  readonly provider = 'gcp-kms';
  readonly keyId: string;
  private serviceAccount: GcpServiceAccount;
  private fetchImpl: typeof fetch;
  private apiBase: string;
  private tokenUrl: string;
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(opts: GcpKmsClientOptions) {
    this.keyId = opts.keyName;
    this.serviceAccount = opts.serviceAccount;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? 'https://cloudkms.googleapis.com/v1';
    this.tokenUrl = opts.tokenUrl ?? 'https://oauth2.googleapis.com/token';
  }

  /** Builds a client from parsed service-account JSON (the key file's contents). */
  static fromServiceAccountJson(keyName: string, json: Record<string, unknown>): GcpKmsClient {
    const clientEmail = json.client_email;
    const privateKeyPem = json.private_key;
    if (typeof clientEmail !== 'string' || typeof privateKeyPem !== 'string') {
      throw new Error('service account JSON is missing client_email/private_key');
    }
    return new GcpKmsClient({ keyName, serviceAccount: { clientEmail, privateKeyPem } });
  }

  async encrypt(plaintext: Buffer): Promise<Buffer> {
    const res = await this.call('encrypt', { plaintext: plaintext.toString('base64') });
    return Buffer.from(res.ciphertext as string, 'base64');
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    const res = await this.call('decrypt', { ciphertext: ciphertext.toString('base64') });
    return Buffer.from(res.plaintext as string, 'base64');
  }

  private async call(
    action: 'encrypt' | 'decrypt',
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`${this.apiBase}/${this.keyId}:${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = raw.error as Record<string, unknown> | undefined;
      throw new KmsError(this.provider, action, String(err?.message ?? res.status));
    }
    return raw;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > Date.now()) {
      return this.accessToken.token;
    }
    const key = await importPKCS8(this.serviceAccount.privateKeyPem, 'RS256');
    const assertion = await new SignJWT({ scope: CLOUDKMS_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.serviceAccount.clientEmail)
      .setAudience(this.tokenUrl)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(key);
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof raw.access_token !== 'string') {
      throw new KmsError(this.provider, 'auth', String(raw.error ?? res.status));
    }
    const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600;
    this.accessToken = { token: raw.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return this.accessToken.token;
  }
}
