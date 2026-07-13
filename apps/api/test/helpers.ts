import { randomBytes } from 'node:crypto';
import { generateSecret, randomToken } from '@connect/crypto';
import {
  accessTokens,
  connectors,
  createDb,
  memberships,
  newId,
  organizations,
  projectLinks,
  projects,
  user,
} from '@connect/db';
import { runMigrations } from '@connect/db/migrate';
import { storeSeedSecret } from '@connect/db/seed-secrets';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app.js';
import { type ApiConfig, loadConfig } from '../src/config.js';
import { type AppDeps, createDeps } from '../src/deps.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://connect:connect@localhost:5432/connect_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

export interface TestHarness {
  deps: AppDeps;
  app: ReturnType<typeof buildApp>['app'];
  issuer: ReturnType<typeof buildApp>['issuer'];
  masterKey: string;
  cleanup(): Promise<void>;
}

export async function createHarness(overrides: Partial<AppDeps> = {}): Promise<TestHarness> {
  const masterKey = randomBytes(32).toString('base64');
  const config: ApiConfig = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    CONNECT_MASTER_KEY: masterKey,
    CONNECT_ISSUER: 'http://connect.test',
    API_KEY_TOKEN_TTL: '900',
  } as NodeJS.ProcessEnv);
  const deps = createDeps(config, overrides);
  const { app, issuer } = buildApp(deps);
  return {
    deps,
    app,
    issuer,
    masterKey,
    cleanup: () => deps.close(),
  };
}

/** Truncates all app tables and flushes the test Redis db. Run once per suite. */
export async function resetState(): Promise<void> {
  const { sql } = createDb(TEST_DATABASE_URL);
  await sql`
    do $$ declare r record;
    begin
      for r in (
        select tablename from pg_tables
        where schemaname = 'public' and tablename not like '__drizzle%'
      ) loop
        execute 'truncate table ' || quote_ident(r.tablename) || ' cascade';
      end loop;
    end $$;
  `;
  await sql.end();
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
  redis.disconnect();
}

export async function ensureMigrated(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}

export interface SeededOrg {
  orgId: string;
  userId: string;
  projectId: string;
  pat: string;
  apiKeyConnectorId: string;
}

/** Minimal org fixture: owner user, PAT, project, api_key connector, full link. */
export async function seedOrg(deps: AppDeps, slugPrefix = 't'): Promise<SeededOrg> {
  const suffix = randomToken(6);
  const orgId = newId.org();
  await deps.db
    .insert(organizations)
    .values({ id: orgId, name: 'Test Org', slug: `${slugPrefix}-${suffix}` });
  const userId = newId.user();
  await deps.db.insert(user).values({
    id: userId,
    name: 'Tester',
    email: `tester-${suffix}@test.dev`,
    emailVerified: true,
  });
  await deps.db
    .insert(memberships)
    .values({ id: newId.membership(), orgId, userId, role: 'owner' });

  const projectId = newId.project();
  await deps.db
    .insert(projects)
    .values({ id: projectId, orgId, name: 'App', slug: `app-${suffix}` });

  const apiKeyConnectorId = newId.connector();
  await deps.db.insert(connectors).values({
    id: apiKeyConnectorId,
    orgId,
    slug: `internal-${suffix}`,
    name: 'Internal API',
    type: 'api_key',
    ingestKey: randomToken(24),
  });
  await storeSeedSecret(
    deps.db,
    deps.keyProvider,
    apiKeyConnectorId,
    'api_key',
    'secret-api-key-value',
  );

  await deps.db.insert(projectLinks).values({
    id: newId.link(),
    projectId,
    connectorId: apiKeyConnectorId,
    environments: ['production', 'development'],
  });

  const pat = generateSecret('cn_pat_');
  await deps.db.insert(accessTokens).values({
    id: newId.accessToken(),
    orgId,
    userId,
    name: 'test',
    tokenHash: pat.hash,
    tokenPrefix: pat.prefix,
  });

  return { orgId, userId, projectId, pat: pat.plaintext, apiKeyConnectorId };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function json(res: Response): Promise<any> {
  return res.json();
}

/** Bridges the SDK's fetch option to Hono's in-process app.request. */
export function appFetch(app: {
  request: (input: any, init?: any) => Response | Promise<Response>;
}): typeof fetch {
  return ((input: any, init?: any) => Promise.resolve(app.request(input, init))) as typeof fetch;
}

export function authed(token: string, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
