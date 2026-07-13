import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EnvKeyProvider,
  decryptSecret,
  encryptSecret,
  secretAad,
} from '../src/envelope.js';
import { generateSecret, hashSecret, verifySecret } from '../src/hash.js';
import { JwtSigner, generateSigningKey } from '../src/jwt.js';

const key = () => randomBytes(32).toString('base64');

describe('EnvKeyProvider', () => {
  it('rejects keys that are not 32 bytes', () => {
    expect(() => new EnvKeyProvider({ v1: Buffer.from('short').toString('base64') }, 'v1')).toThrow(
      /32 bytes/,
    );
  });

  it('rejects a missing current version', () => {
    expect(() => new EnvKeyProvider({ v1: key() }, 'v2')).toThrow(/current key version/);
  });
});

describe('envelope encryption', () => {
  const kp = new EnvKeyProvider({ v1: key() }, 'v1');
  const aad = secretAad('connector_secrets', 'cs_1', 'api_key');

  it('round-trips plaintext', () => {
    const blob = encryptSecret(kp, aad, 'super-secret-value');
    expect(decryptSecret(kp, aad, blob)).toBe('super-secret-value');
  });

  it('produces unique IVs and DEKs per call', () => {
    const a = encryptSecret(kp, aad, 'same');
    const b = encryptSecret(kp, aad, 'same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.data).not.toBe(b.data);
  });

  it('rejects decryption with mismatched AAD (ciphertext swapping)', () => {
    const blob = encryptSecret(kp, aad, 'value');
    const otherAad = secretAad('connector_secrets', 'cs_2', 'api_key');
    expect(() => decryptSecret(kp, otherAad, blob)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const blob = encryptSecret(kp, aad, 'value');
    const corrupted = Buffer.from(blob.data, 'base64');
    corrupted[0]! ^= 0xff;
    expect(() => decryptSecret(kp, aad, { ...blob, data: corrupted.toString('base64') })).toThrow();
  });

  it('rejects decryption with the wrong master key', () => {
    const blob = encryptSecret(kp, aad, 'value');
    const otherKp = new EnvKeyProvider({ v1: key() }, 'v1');
    expect(() => decryptSecret(otherKp, aad, blob)).toThrow();
  });

  it('supports key rotation: old blobs decrypt via old version, new blobs use new version', () => {
    const v1 = key();
    const kpOld = new EnvKeyProvider({ v1 }, 'v1');
    const blobOld = encryptSecret(kpOld, aad, 'old-secret');

    const kpRotated = new EnvKeyProvider({ v1, v2: key() }, 'v2');
    expect(decryptSecret(kpRotated, aad, blobOld)).toBe('old-secret');

    const blobNew = encryptSecret(kpRotated, aad, 'new-secret');
    expect(blobNew.keyVersion).toBe('v2');
    expect(decryptSecret(kpRotated, aad, blobNew)).toBe('new-secret');
  });

  it('rejects unknown key versions', () => {
    const blob = encryptSecret(kp, aad, 'value');
    expect(() => decryptSecret(kp, aad, { ...blob, keyVersion: 'v9' })).toThrow(/unknown key version/);
  });
});

describe('secret hashing', () => {
  it('generates prefixed secrets and verifies them', () => {
    const s = generateSecret('cn_pat_');
    expect(s.plaintext.startsWith('cn_pat_')).toBe(true);
    expect(s.prefix).toBe(s.plaintext.slice(0, 12));
    expect(s.hash).toBe(hashSecret(s.plaintext));
    expect(verifySecret(s.plaintext, s.hash)).toBe(true);
    expect(verifySecret(s.plaintext + 'x', s.hash)).toBe(false);
  });
});

describe('JwtSigner', () => {
  it('signs and verifies with issuer/audience enforcement', async () => {
    const signer = await JwtSigner.fromPem(await generateSigningKey('kid-1'));
    const jwt = await signer.sign(
      { sub: 'project:p1:env:production', org_id: 'org_1' },
      { issuer: 'http://localhost:4000', audience: 'connect', ttlSeconds: 600 },
    );
    const payload = await signer.verify(jwt, { issuer: 'http://localhost:4000', audience: 'connect' });
    expect(payload.sub).toBe('project:p1:env:production');
    expect(payload.org_id).toBe('org_1');

    await expect(
      signer.verify(jwt, { issuer: 'http://evil.example', audience: 'connect' }),
    ).rejects.toThrow();
  });

  it('serves a JWKS containing the public key', async () => {
    const signer = await JwtSigner.fromPem(await generateSigningKey('kid-2'));
    const jwks = await signer.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kid: 'kid-2', use: 'sig', alg: 'ES256', kty: 'EC' });
    expect(jwks.keys[0]).not.toHaveProperty('d'); // no private material
  });
});
