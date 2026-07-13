import { desc, eq } from 'drizzle-orm';
import { signingKeys, type Db } from '@connect/db';
import {
  JwtSigner,
  decryptSecret,
  encryptSecret,
  generateSigningKey,
  secretAad,
  type EncryptedBlob,
  type KeyProvider,
} from '@connect/crypto';
import type { Environment } from '@connect/shared';

export interface WorkloadClaims {
  orgId: string;
  projectId: string;
  environment: Environment;
}

export const OIDC_AUDIENCE = 'connect';
export const WORKLOAD_TOKEN_TTL = 600; // 10 minutes

/**
 * Connect's own OIDC issuer: signs workload identity JWTs and serves JWKS.
 * The ES256 private key lives envelope-encrypted in the signing_keys table.
 */
export class IssuerService {
  private signer: JwtSigner | null = null;

  constructor(
    private db: Db,
    private kp: KeyProvider,
    private issuerUrl: string,
  ) {}

  /** Loads the active signing key, creating one on first boot. */
  async ensureSigner(): Promise<JwtSigner> {
    if (this.signer) return this.signer;
    const [row] = await this.db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.active, true))
      .orderBy(desc(signingKeys.createdAt))
      .limit(1);
    if (row) {
      let privatePem: string;
      try {
        privatePem = decryptSecret(
          this.kp,
          secretAad('signing_keys', row.id, 'private_key'),
          row.privateKeyCiphertext as EncryptedBlob,
        );
      } catch (err) {
        throw new Error(
          `cannot decrypt signing key ${row.id}: CONNECT_MASTER_KEY does not match the key that encrypted it (${String(err)})`,
        );
      }
      this.signer = await JwtSigner.fromPem({
        kid: row.id,
        privatePem,
        publicPem: row.publicKeyPem,
      });
      return this.signer;
    }
    const kid = `key_${Date.now().toString(36)}`;
    const pem = await generateSigningKey(kid);
    await this.db.insert(signingKeys).values({
      id: kid,
      privateKeyCiphertext: encryptSecret(
        this.kp,
        secretAad('signing_keys', kid, 'private_key'),
        pem.privatePem,
      ),
      publicKeyPem: pem.publicPem,
    });
    this.signer = await JwtSigner.fromPem(pem);
    return this.signer;
  }

  async mintWorkloadToken(claims: WorkloadClaims): Promise<{ token: string; expiresIn: number }> {
    const signer = await this.ensureSigner();
    const token = await signer.sign(
      {
        sub: `project:${claims.projectId}:env:${claims.environment}`,
        org_id: claims.orgId,
        project_id: claims.projectId,
        environment: claims.environment,
      },
      { issuer: this.issuerUrl, audience: OIDC_AUDIENCE, ttlSeconds: WORKLOAD_TOKEN_TTL },
    );
    return { token, expiresIn: WORKLOAD_TOKEN_TTL };
  }

  async verifyWorkloadToken(token: string): Promise<WorkloadClaims> {
    const signer = await this.ensureSigner();
    const payload = await signer.verify(token, {
      issuer: this.issuerUrl,
      audience: OIDC_AUDIENCE,
    });
    const { org_id, project_id, environment } = payload as Record<string, unknown>;
    if (
      typeof org_id !== 'string' ||
      typeof project_id !== 'string' ||
      typeof environment !== 'string'
    ) {
      throw new Error('malformed workload token claims');
    }
    return {
      orgId: org_id,
      projectId: project_id,
      environment: environment as Environment,
    };
  }

  async jwks() {
    const signer = await this.ensureSigner();
    return signer.jwks();
  }

  openidConfiguration() {
    return {
      issuer: this.issuerUrl,
      jwks_uri: `${this.issuerUrl}/.well-known/jwks.json`,
      token_endpoint: `${this.issuerUrl}/v1/oidc/token`,
      grant_types_supported: ['client_credentials'],
      id_token_signing_alg_values_supported: ['ES256'],
    };
  }
}
