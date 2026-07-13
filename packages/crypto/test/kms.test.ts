import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  EnvKeyProvider,
  encryptSecret,
  rewrapSecret,
  secretAad,
} from '../src/envelope.js';
import { signAwsRequest } from '../src/kms/aws.js';
import { GcpKmsClient } from '../src/kms/gcp.js';
import { KmsKeyProvider } from '../src/kms/provider.js';
import type { KmsClient } from '../src/kms/types.js';

/** In-memory KMS: AES-GCM under a fixed key, mimicking remote wrap/unwrap. */
function fakeKms(provider = 'fake-kms'): KmsClient {
  const key = randomBytes(32);
  return {
    provider,
    keyId: 'arn:fake:key/1',
    async encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]);
    },
    async decrypt(ciphertext) {
      const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    },
  };
}

describe('KmsKeyProvider', () => {
  const aad = secretAad('connector_secrets', 'cs_1', 'api_key');

  it('round-trips secrets through a KMS-wrapped KEK', async () => {
    const kms = fakeKms();
    const { wrappedKek } = await KmsKeyProvider.generateKek(kms);
    const kp = await KmsKeyProvider.load(kms, [{ version: 'v1', wrappedKek }], 'v1');
    const blob = encryptSecret(kp, aad, 'kms-protected');
    expect(blob.keyVersion).toBe('v1');
    expect(decryptSecret(kp, aad, blob)).toBe('kms-protected');
  });

  it('supports multiple KEK versions with the newest wrapping new DEKs', async () => {
    const kms = fakeKms();
    const v1 = await KmsKeyProvider.generateKek(kms);
    const kp1 = await KmsKeyProvider.load(
      kms,
      [{ version: 'v1', wrappedKek: v1.wrappedKek }],
      'v1',
    );
    const oldBlob = encryptSecret(kp1, aad, 'old');

    const v2 = await KmsKeyProvider.generateKek(kms);
    const kp2 = await KmsKeyProvider.load(
      kms,
      [
        { version: 'v1', wrappedKek: v1.wrappedKek },
        { version: 'v2', wrappedKek: v2.wrappedKek },
      ],
      'v2',
    );
    // old blobs decrypt, new blobs wrap under v2
    expect(decryptSecret(kp2, aad, oldBlob)).toBe('old');
    expect(encryptSecret(kp2, aad, 'new').keyVersion).toBe('v2');
  });

  it('refuses to load without any versions', async () => {
    await expect(KmsKeyProvider.load(fakeKms(), [], 'v1')).rejects.toThrow(/no master key/);
  });
});

describe('rewrapSecret', () => {
  const aad = secretAad('triggers', 'trig_1', 'signing_secret');

  it('re-wraps the DEK to the current version without touching the data', () => {
    const v1 = randomBytes(32).toString('base64');
    const v2 = randomBytes(32).toString('base64');
    const kpOld = new EnvKeyProvider({ v1 }, 'v1');
    const blob = encryptSecret(kpOld, aad, 'value');

    const kpNew = new EnvKeyProvider({ v1, v2 }, 'v2');
    const rewrapped = rewrapSecret(kpNew, blob);
    expect(rewrapped.keyVersion).toBe('v2');
    expect(rewrapped.data).toBe(blob.data);
    expect(rewrapped.iv).toBe(blob.iv);
    expect(rewrapped.wrappedDek).not.toBe(blob.wrappedDek);
    expect(decryptSecret(kpNew, aad, rewrapped)).toBe('value');

    // a provider that no longer holds v1 can decrypt the re-wrapped blob
    const kpV2Only = new EnvKeyProvider({ v2 }, 'v2');
    expect(decryptSecret(kpV2Only, aad, rewrapped)).toBe('value');
    expect(() => decryptSecret(kpV2Only, aad, blob)).toThrow(/unknown key version/);
  });

  it('is a no-op when already on the current version', () => {
    const kp = new EnvKeyProvider({ v1: randomBytes(32).toString('base64') }, 'v1');
    const blob = encryptSecret(kp, aad, 'value');
    expect(rewrapSecret(kp, blob)).toBe(blob);
  });
});

describe('signAwsRequest', () => {
  it('matches the worked example in the AWS SigV4 documentation', () => {
    // "Complete signature version 4 example": GET ListUsers on IAM.
    const headers = signAwsRequest({
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      region: 'us-east-1',
      service: 'iam',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      date: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('includes the session token in signed headers when present', () => {
    const headers = signAwsRequest({
      method: 'POST',
      url: new URL('https://kms.us-east-1.amazonaws.com/'),
      headers: { 'content-type': 'application/x-amz-json-1.1' },
      body: '{}',
      region: 'us-east-1',
      service: 'kms',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'tok' },
    });
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.authorization).toContain('x-amz-security-token');
  });
});

describe('GcpKmsClient', () => {
  it('exchanges a service-account JWT for a token and calls encrypt/decrypt', async () => {
    // generate a throwaway RSA key for the fake service account
    const { generateKeyPair, exportPKCS8 } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);

    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body) });
      if (url.includes('token')) {
        return Response.json({ access_token: 'at-1', expires_in: 3600 });
      }
      if (url.endsWith(':encrypt')) {
        const { plaintext } = JSON.parse(String(init?.body)) as { plaintext: string };
        return Response.json({
          ciphertext: Buffer.from(`wrapped:${plaintext}`).toString('base64'),
        });
      }
      const { ciphertext } = JSON.parse(String(init?.body)) as { ciphertext: string };
      const raw = Buffer.from(ciphertext, 'base64')
        .toString()
        .replace(/^wrapped:/, '');
      return Response.json({ plaintext: raw });
    }) as typeof fetch;

    const client = new GcpKmsClient({
      keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      serviceAccount: { clientEmail: 'svc@p.iam.gserviceaccount.com', privateKeyPem },
      fetchImpl,
    });

    const kek = randomBytes(32);
    const wrapped = await client.encrypt(kek);
    const unwrapped = await client.decrypt(wrapped);
    expect(unwrapped.equals(kek)).toBe(true);

    // token fetched once (cached), then encrypt + decrypt
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    expect(calls.some((c) => c.url.endsWith(':encrypt'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith(':decrypt'))).toBe(true);
  });
});
