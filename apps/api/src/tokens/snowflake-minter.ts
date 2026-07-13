import { mintSnowflakeJwt } from '@connect/crypto';
import { ConnectError, type SnowflakeConfig, snowflakeConfigSchema } from '@connect/shared';
import type { CachedToken } from './cache.js';
import { type ConnectorRow, type Minter, readConnectorSecret } from './minters.js';

/**
 * Snowflake key-pair exchange: signs a KEYPAIR_JWT with the connector's stored
 * RSA private key. The caller sends it as a Bearer token with
 * `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`.
 */
export const mintSnowflakeToken: Minter = async ({ deps, connector, subject }) => {
  if (subject.type !== 'app') {
    throw new ConnectError(
      'unsupported_subject',
      'snowflake connectors only support the app subject',
    );
  }
  const cfg = snowflakeConfigOf(connector);
  const privateKeyPem = await readConnectorSecret(
    deps.db,
    deps.keyProvider,
    connector.id,
    'snowflake_private_key',
  );
  if (!privateKeyPem) {
    throw new ConnectError('grant_expired', 'no private key stored for this snowflake connector');
  }

  const jwt = await mintSnowflakeJwt({
    account: cfg.account,
    username: cfg.username,
    privateKeyPem,
    ttlSeconds: cfg.tokenTtlSeconds,
  });

  const result: CachedToken = {
    token: jwt.token,
    tokenType: 'bearer',
    expiresAt: jwt.expiresAt.toISOString(),
    scopes: [],
  };
  return result;
};

export function snowflakeConfigOf(connector: ConnectorRow): SnowflakeConfig {
  const parsed = snowflakeConfigSchema.safeParse(connector.providerConfig ?? {});
  if (!parsed.success) {
    throw new ConnectError(
      'validation_error',
      'connector has no valid snowflake configuration (account, username)',
    );
  }
  return parsed.data;
}
