import { createHash, createPublicKey } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';

/**
 * Snowflake key-pair authentication (KEYPAIR_JWT): a short-lived RS256 JWT
 * whose issuer embeds the SHA-256 fingerprint of the public key registered on
 * the Snowflake user. Minted locally — no provider round-trip.
 */

export interface SnowflakeJwtParams {
  /** Account identifier; a region suffix ("xy12345.us-east-1") is stripped. */
  account: string;
  username: string;
  /** PKCS#8 PEM RSA private key (the pair registered via RSA_PUBLIC_KEY). */
  privateKeyPem: string;
  ttlSeconds: number;
}

export interface SnowflakeJwt {
  token: string;
  expiresAt: Date;
  /** "SHA256:<base64>" fingerprint of the DER-encoded public key. */
  fingerprint: string;
}

/** Snowflake's fingerprint format: SHA256:<base64 of DER SPKI public key>. */
export function snowflakePublicKeyFingerprint(privateKeyPem: string): string {
  const publicKey = createPublicKey(privateKeyPem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

export async function mintSnowflakeJwt(params: SnowflakeJwtParams): Promise<SnowflakeJwt> {
  // the JWT wants the bare account locator, uppercased, without region/cloud
  const account = params.account.split('.')[0]!.toUpperCase();
  const username = params.username.toUpperCase();
  const qualified = `${account}.${username}`;
  const fingerprint = snowflakePublicKeyFingerprint(params.privateKeyPem);

  const ttl = Math.min(params.ttlSeconds, 3600); // Snowflake rejects exp > 1h out
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const key = await importPKCS8(params.privateKeyPem, 'RS256');
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(`${qualified}.${fingerprint}`)
    .setSubject(qualified)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);

  return { token, expiresAt, fingerprint };
}
