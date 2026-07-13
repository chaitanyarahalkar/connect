import { EnvKeyProvider, generateSecret, randomToken } from '@connect/crypto';
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { newId } from './ids.js';
import {
  accessTokens,
  connectors,
  memberships,
  organizations,
  projectLinks,
  projects,
  user,
} from './schema.js';

/**
 * Seeds a demo org with a mock-OAuth connector, an api-key connector, a
 * project linked to both, and a PAT (printed once). Idempotent-ish: skips if
 * the demo org already exists.
 */
export async function seed(databaseUrl: string, masterKey: string) {
  const { db, sql } = createDb(databaseUrl);
  const kp = new EnvKeyProvider({ v1: masterKey }, 'v1');

  const existing = await db.select().from(organizations).where(eq(organizations.slug, 'demo'));
  if (existing.length) {
    console.log('demo org already seeded');
    await sql.end();
    return null;
  }

  const orgId = newId.org();
  await db.insert(organizations).values({ id: orgId, name: 'Demo Org', slug: 'demo' });

  const userId = newId.user();
  await db.insert(user).values({
    id: userId,
    name: 'Demo User',
    email: 'demo@connect.dev',
    emailVerified: true,
  });
  await db.insert(memberships).values({
    id: newId.membership(),
    orgId,
    userId,
    role: 'owner',
  });

  const projectId = newId.project();
  await db.insert(projects).values({ id: projectId, orgId, name: 'Demo App', slug: 'demo-app' });

  // API-key connector with a stored credential
  const apiKeyConnectorId = newId.connector();
  await db.insert(connectors).values({
    id: apiKeyConnectorId,
    orgId,
    slug: 'internal-api',
    name: 'Internal API (api key)',
    type: 'api_key',
    ingestKey: randomToken(24),
  });
  const { storeSeedSecret } = await import('./seed-secrets.js');
  await storeSeedSecret(db, kp, apiKeyConnectorId, 'api_key', 'demo-api-key-12345');

  // Mock OAuth connector (works against apps/mock-provider)
  const mockUrl = process.env.MOCK_PROVIDER_URL ?? 'http://localhost:4100';
  const oauthConnectorId = newId.connector();
  await db.insert(connectors).values({
    id: oauthConnectorId,
    orgId,
    slug: 'mock-oauth',
    name: 'Mock OAuth Provider',
    type: 'oauth2',
    clientId: 'mock-client-id',
    oauthConfig: {
      authorizationEndpoint: `${mockUrl}/oauth/authorize`,
      tokenEndpoint: `${mockUrl}/oauth/token`,
      revocationEndpoint: `${mockUrl}/oauth/revoke`,
      userinfoEndpoint: `${mockUrl}/oauth/userinfo`,
      scopesDefault: ['read', 'write'],
      pkce: true,
      tokenEndpointAuth: 'post',
      quirksKey: 'mock',
    },
    ingestKey: randomToken(24),
  });
  await storeSeedSecret(db, kp, oauthConnectorId, 'oauth_client_secret', 'mock-client-secret');
  await storeSeedSecret(db, kp, oauthConnectorId, 'webhook_secret', 'mock-webhook-secret');

  await db.insert(projectLinks).values([
    {
      id: newId.link(),
      projectId,
      connectorId: apiKeyConnectorId,
      environments: ['production', 'preview', 'development'],
    },
    {
      id: newId.link(),
      projectId,
      connectorId: oauthConnectorId,
      environments: ['production', 'development'],
    },
  ]);

  const pat = generateSecret('cn_pat_');
  await db.insert(accessTokens).values({
    id: newId.accessToken(),
    orgId,
    userId,
    name: 'seed token',
    tokenHash: pat.hash,
    tokenPrefix: pat.prefix,
  });

  await sql.end();
  return {
    orgId,
    projectId,
    apiKeyConnectorId,
    oauthConnectorId,
    pat: pat.plaintext,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgres://connect:connect@localhost:5432/connect';
  const masterKey = process.env.CONNECT_MASTER_KEY;
  if (!masterKey) {
    console.error('CONNECT_MASTER_KEY required');
    process.exit(1);
  }
  seed(databaseUrl, masterKey)
    .then((result) => {
      if (result) {
        console.log('seeded demo org.');
        console.log('  login:  demo@connect.dev (set password via dashboard signup)');
        console.log(`  PAT (shown once): ${result.pat}`);
        console.log(`  project: ${result.projectId}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
