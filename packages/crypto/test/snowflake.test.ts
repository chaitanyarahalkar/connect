import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { mintSnowflakeJwt, snowflakePublicKeyFingerprint } from '../src/snowflake.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('snowflake KEYPAIR_JWT', () => {
  it('mints an RS256 JWT with the fingerprinted issuer Snowflake expects', async () => {
    const jwt = await mintSnowflakeJwt({
      account: 'xy12345.us-east-1',
      username: 'svc_analytics',
      privateKeyPem,
      ttlSeconds: 600,
    });

    expect(decodeProtectedHeader(jwt.token)).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeJwt(jwt.token);
    // region suffix stripped, everything uppercased
    expect(claims.sub).toBe('XY12345.SVC_ANALYTICS');
    expect(claims.iss).toBe(`XY12345.SVC_ANALYTICS.${jwt.fingerprint}`);
    expect(jwt.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+=*$/);
    expect(jwt.fingerprint).toBe(snowflakePublicKeyFingerprint(privateKeyPem));

    const exp = (claims.exp ?? 0) * 1000;
    expect(exp - Date.now()).toBeLessThanOrEqual(600_000);
    expect(exp - Date.now()).toBeGreaterThan(590_000);

    // verifiable with the registered public key
    const key = await importSPKI(publicKeyPem, 'RS256');
    await expect(jwtVerify(jwt.token, key)).resolves.toBeDefined();
  });

  it('caps the TTL at one hour', async () => {
    const jwt = await mintSnowflakeJwt({
      account: 'acme',
      username: 'u',
      privateKeyPem,
      ttlSeconds: 86_400,
    });
    const claims = decodeJwt(jwt.token);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBeLessThanOrEqual(3600);
  });
});
