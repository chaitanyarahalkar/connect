import { decryptSecret, type EncryptedBlob, type KeyProvider, secretAad } from '@connect/crypto';
import {
  connectorSecrets,
  type connectors,
  type Db,
  installationGrants,
  type installations,
} from '@connect/db';
import { ConnectError, type TokenSubject } from '@connect/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from '../deps.js';
import type { CachedToken } from './cache.js';

export type ConnectorRow = typeof connectors.$inferSelect;
export type InstallationRow = typeof installations.$inferSelect;

export interface MintContext {
  deps: AppDeps;
  connector: ConnectorRow;
  installation: InstallationRow | null;
  subject: TokenSubject;
  scopes: string[];
  resource?: string;
  authorizationDetails?: Record<string, unknown>[];
}

export type Minter = (ctx: MintContext) => Promise<CachedToken>;

export async function readConnectorSecret(
  db: Db,
  kp: KeyProvider,
  connectorId: string,
  kind: (typeof connectorSecrets.$inferSelect)['kind'],
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(connectorSecrets)
    .where(and(eq(connectorSecrets.connectorId, connectorId), eq(connectorSecrets.kind, kind)))
    .limit(1);
  if (!row) return null;
  return decryptSecret(
    kp,
    secretAad('connector_secrets', row.id, kind),
    row.ciphertext as EncryptedBlob,
  );
}

export async function getActiveGrant(
  db: Db,
  installationId: string,
  grantType: (typeof installationGrants.$inferSelect)['grantType'],
) {
  const [row] = await db
    .select()
    .from(installationGrants)
    .where(
      and(
        eq(installationGrants.installationId, installationId),
        eq(installationGrants.grantType, grantType),
        isNull(installationGrants.supersededById),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function decryptGrant(
  kp: KeyProvider,
  grant: typeof installationGrants.$inferSelect,
): string {
  return decryptSecret(
    kp,
    secretAad('installation_grants', grant.installationId, grant.grantType),
    grant.ciphertext as EncryptedBlob,
  );
}

/** api_key connectors: return the stored credential under a policy TTL. */
export const mintApiKeyToken: Minter = async ({ deps, connector, subject }) => {
  if (subject.type !== 'app') {
    throw new ConnectError(
      'unsupported_subject',
      'api_key connectors only support the app subject',
    );
  }
  const apiKey = await readConnectorSecret(deps.db, deps.keyProvider, connector.id, 'api_key');
  if (!apiKey) {
    throw new ConnectError('grant_expired', 'no API key stored for this connector');
  }
  return {
    token: apiKey,
    tokenType: 'api_key',
    expiresAt: new Date(Date.now() + deps.config.apiKeyTokenTtl * 1000).toISOString(),
    scopes: [],
  };
};
