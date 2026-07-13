import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  type JWTPayload,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';

/**
 * ES256 signer for Connect-issued workload identity JWTs. The private key is
 * generated at seed time and stored envelope-encrypted; JWKS is served from
 * the public key.
 */

export interface SigningKeyPem {
  kid: string;
  privatePem: string;
  publicPem: string;
}

export async function generateSigningKey(kid: string): Promise<SigningKeyPem> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    kid,
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
  };
}

export class JwtSigner {
  private constructor(
    private privateKey: KeyLike,
    private publicKey: KeyLike,
    public kid: string,
  ) {}

  static async fromPem(key: SigningKeyPem): Promise<JwtSigner> {
    return new JwtSigner(
      await importPKCS8(key.privatePem, 'ES256'),
      await importSPKI(key.publicPem, 'ES256'),
      key.kid,
    );
  }

  async sign(payload: JWTPayload, opts: { issuer: string; audience: string; ttlSeconds: number }): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: this.kid })
      .setIssuer(opts.issuer)
      .setAudience(opts.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + opts.ttlSeconds)
      .sign(this.privateKey);
  }

  async verify(token: string, opts: { issuer: string; audience: string }): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    return payload;
  }

  async jwks(): Promise<JSONWebKeySet> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: this.kid, use: 'sig', alg: 'ES256' }] };
  }
}
