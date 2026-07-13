/**
 * End-to-end demo: boots the API and mock OAuth provider over real HTTP, then
 * walks every core flow — api-key tokens, the full OAuth dance, caching,
 * refresh, workload identity, and signed webhook delivery.
 *
 * Prereqs: Postgres + Redis running (docker compose up -d), migrations applied.
 * Run: pnpm demo
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { storeSeedSecret } from '@connect/db/seed-secrets';
import { EnvKeyProvider, generateSecret, randomToken } from '@connect/crypto';
import { getToken, clearTokenCache } from '@connect/sdk';
import { loadDotEnv } from '../src/config.js';

// Use the repo .env when present so the master key stays stable across runs
// (signing keys and seeded secrets in the dev DB are encrypted under it).
loadDotEnv();

const API = 'http://localhost:4000';
const MOCK = 'http://localhost:4100';
const RECEIVER_PORT = 4200;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://connect:connect@localhost:5432/connect';
const MASTER_KEY = process.env.CONNECT_MASTER_KEY ?? randomBytes(32).toString('base64');

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const children: ChildProcess[] = [];
let receiverServer: ReturnType<typeof createServer> | null = null;

function step(name: string) {
  process.stdout.write(`\n▶ ${name}\n`);
}
function ok(msg: string) {
  process.stdout.write(`  ✔ ${msg}\n`);
}

function spawnService(name: string, cwd: string, entry: string, env: Record<string, string>) {
  const child = spawn('pnpm', ['tsx', entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up in time`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string, token: string, body?: unknown, method?: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function seedDemoOrg() {
  const { db, sql } = createDb(DATABASE_URL);
  const kp = new EnvKeyProvider({ v1: MASTER_KEY }, 'v1');
  const suffix = randomToken(6).toLowerCase();

  const orgId = newId.org();
  await db.insert(organizations).values({ id: orgId, name: 'Demo Org', slug: `demo-${suffix}` });
  const userId = newId.user();
  await db.insert(user).values({
    id: userId,
    name: 'Demo User',
    email: `demo-${suffix}@connect.dev`,
    emailVerified: true,
  });
  await db.insert(memberships).values({ id: newId.membership(), orgId, userId, role: 'owner' });

  const projectId = newId.project();
  await db.insert(projects).values({ id: projectId, orgId, name: 'Demo App', slug: `demo-app-${suffix}` });

  const apiKeyConnectorId = newId.connector();
  await db.insert(connectors).values({
    id: apiKeyConnectorId,
    orgId,
    slug: 'internal-api',
    name: 'Internal API',
    type: 'api_key',
    ingestKey: randomToken(24),
  });
  await storeSeedSecret(db, kp, apiKeyConnectorId, 'api_key', 'demo-api-key-12345');

  const webhookSecret = `mock-webhook-${suffix}`;
  const oauthConnectorId = newId.connector();
  const ingestKey = randomToken(24);
  await db.insert(connectors).values({
    id: oauthConnectorId,
    orgId,
    slug: 'mock-oauth',
    name: 'Mock OAuth Provider',
    type: 'oauth2',
    clientId: 'mock-client-id',
    oauthConfig: {
      authorizationEndpoint: `${MOCK}/oauth/authorize`,
      tokenEndpoint: `${MOCK}/oauth/token`,
      revocationEndpoint: `${MOCK}/oauth/revoke`,
      userinfoEndpoint: `${MOCK}/oauth/userinfo`,
      scopesDefault: ['read'],
      pkce: true,
      tokenEndpointAuth: 'post',
      quirksKey: 'mock',
    },
    ingestKey,
  });
  await storeSeedSecret(db, kp, oauthConnectorId, 'oauth_client_secret', 'mock-client-secret');
  await storeSeedSecret(db, kp, oauthConnectorId, 'webhook_secret', webhookSecret);

  await db.insert(projectLinks).values([
    { id: newId.link(), projectId, connectorId: apiKeyConnectorId, environments: ['production', 'development'] },
    { id: newId.link(), projectId, connectorId: oauthConnectorId, environments: ['production'] },
  ]);

  const pat = generateSecret('cn_pat_');
  await db.insert(accessTokens).values({
    id: newId.accessToken(),
    orgId,
    userId,
    name: 'demo',
    tokenHash: pat.hash,
    tokenPrefix: pat.prefix,
  });

  await sql.end();
  return { orgId, projectId, apiKeyConnectorId, oauthConnectorId, ingestKey, webhookSecret, pat: pat.plaintext };
}

async function main() {
  step('starting services (api :4000, mock provider :4100)');
  spawnService('api', apiDir, 'src/index.ts', {
    CONNECT_MASTER_KEY: MASTER_KEY,
    DATABASE_URL,
    LOG_LEVEL: 'warn',
  });
  spawnService('mock', join(apiDir, '..', 'mock-provider'), 'src/index.ts', {
    MOCK_TOKEN_TTL: '90',
  });
  await waitFor(`${API}/health`);
  await waitFor(`${MOCK}/oauth/userinfo`);
  ok('both services healthy');

  step('seeding a demo org (project, connectors, links, PAT)');
  const seed = await seedDemoOrg();
  ok(`org seeded — PAT ${seed.pat.slice(0, 12)}…`);

  step('api-key connector: SDK getToken round trip');
  clearTokenCache();
  const apiKeyToken = await getToken(
    { connector: 'internal-api' },
    { baseUrl: API, auth: seed.pat },
  );
  if (apiKeyToken.token !== 'demo-api-key-12345') throw new Error('unexpected api key');
  ok(`received stored key under policy TTL (expires ${apiKeyToken.expiresAt.toISOString()})`);

  step('oauth: authorize → consent → callback (real HTTP)');
  const { url } = await api(`/v1/connectors/${seed.oauthConnectorId}/authorize`, seed.pat, {});
  const consent = await fetch(`${url}&auto=1`, { redirect: 'manual' });
  const cbUrl = consent.headers.get('location')!;
  const cb = await fetch(cbUrl, { redirect: 'manual' });
  if (cb.status !== 302) throw new Error(`callback failed: ${cb.status}`);
  ok('installation created via authorization-code + PKCE');

  step('oauth: mint a provider token and call the provider with it');
  const t1 = (await api('/v1/tokens', seed.pat, { connector: 'mock-oauth' })) as {
    token: string;
    cached: boolean;
  };
  const providerData = await fetch(`${MOCK}/api/data`, {
    headers: { authorization: `Bearer ${t1.token}` },
  });
  if (!providerData.ok) throw new Error('provider rejected minted token');
  ok(`token works against provider API (cached=${t1.cached})`);

  const t2 = (await api('/v1/tokens', seed.pat, { connector: 'mock-oauth' })) as { cached: boolean };
  if (!t2.cached) throw new Error('expected cache hit');
  ok('second request served from encrypted Redis cache');

  step('oauth: force a refresh (rotating refresh token)');
  const t3 = (await api('/v1/tokens', seed.pat, { connector: 'mock-oauth', scopes: ['write'] })) as {
    token: string;
  };
  const refreshedWorks = await fetch(`${MOCK}/api/data`, {
    headers: { authorization: `Bearer ${t3.token}` },
  });
  if (!refreshedWorks.ok) throw new Error('refreshed token rejected');
  ok('refresh flow executed; rotated grant stored');

  step('workload identity: client credentials → OIDC JWT → scoped token');
  const client = (await api(`/v1/projects/${seed.projectId}/clients`, seed.pat, {
    environment: 'production',
  })) as { client: { clientId: string; clientSecret: string } };
  const oidc = await fetch(`${API}/v1/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.client.clientId,
      client_secret: client.client.clientSecret,
    }),
  });
  if (!oidc.ok) throw new Error(`client-credentials exchange failed: ${oidc.status} ${await oidc.text()}`);
  const { access_token } = (await oidc.json()) as { access_token: string };
  const viaWorkload = (await api('/v1/tokens', access_token, { connector: 'internal-api' })) as {
    token: string;
  };
  if (viaWorkload.token !== 'demo-api-key-12345') throw new Error('workload token flow failed');
  ok('deployment identity minted a token under project-link enforcement');

  step('triggers: signed webhook → verify → fan out → destination');
  const received: { headers: Record<string, string>; body: string }[] = [];
  receiverServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(200).end('ok');
    });
  }).listen(RECEIVER_PORT);

  const trig = (await api(`/v1/connectors/${seed.oauthConnectorId}/triggers`, seed.pat, {
    name: 'demo destination',
    destinationUrl: `http://localhost:${RECEIVER_PORT}/hook`,
  })) as { trigger: { signingSecret: string } };

  const sent = await fetch(`${MOCK}/send-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${API}/v1/webhooks/${seed.oauthConnectorId}/${seed.ingestKey}`,
      secret: seed.webhookSecret,
      event: { type: 'demo.event', hello: 'world' },
    }),
  });
  if (!(await sent.json() as { delivered: boolean }).delivered) throw new Error('ingest rejected webhook');

  const deadline = Date.now() + 15_000;
  while (!received.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (!received.length) throw new Error('delivery never arrived');
  const delivery = received[0]!;
  const expected = `sha256=${createHmac('sha256', trig.trigger.signingSecret).update(delivery.body).digest('hex')}`;
  if (delivery.headers['connect-signature'] !== expected) throw new Error('forwarded signature invalid');
  ok('webhook verified at ingest, fanned out, and signed for the destination');

  step('usage metering');
  const usage = (await api('/v1/usage', seed.pat)) as { daily: { kind: string; total: number }[] };
  const tokens = usage.daily.filter((d) => d.kind === 'token_request').reduce((s, d) => s + d.total, 0);
  const hooks = usage.daily.filter((d) => d.kind === 'webhook_delivery').reduce((s, d) => s + d.total, 0);
  ok(`metered ${tokens} token requests, ${hooks} webhook deliveries`);

  console.log('\n🎉 demo complete — every core flow verified end to end\n');
}

main()
  .catch((err) => {
    console.error(`\n✖ demo failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    receiverServer?.close();
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
