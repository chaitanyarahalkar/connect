import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  createHarness,
  ensureMigrated,
  json,
  resetState,
  type SeededOrg,
  seedOrg,
  type TestHarness,
} from './helpers.js';

let h: TestHarness;
let org: SeededOrg;

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness();
  org = await seedOrg(h.deps);
});

afterAll(async () => {
  await h.cleanup();
});

async function setPolicy(policy: unknown) {
  const res = await h.app.request(`/v1/connectors/${org.apiKeyConnectorId}`, {
    ...authed(org.pat, { tokenPolicy: policy }),
    method: 'PATCH',
  });
  expect(res.status).toBe(200);
  return json(res);
}

function mintRequest() {
  return h.app.request('/v1/tokens', authed(org.pat, { connector: org.apiKeyConnectorId }));
}

describe('per-connector token policies', () => {
  it('accepts and returns tokenPolicy on the connector resource', async () => {
    const body = await setPolicy({ maxTtlSeconds: 300 });
    expect(body.connector.tokenPolicy).toEqual({ maxTtlSeconds: 300 });
  });

  it('clamps the advertised token TTL to maxTtlSeconds', async () => {
    await setPolicy({ maxTtlSeconds: 300 });
    const res = await mintRequest();
    expect(res.status).toBe(200);
    const body = await json(res);
    // api_key policy TTL is 900s; the policy caps it at 300s
    const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(300_000);
    expect(ttlMs).toBeGreaterThan(200_000);
  });

  it('rejects scopes outside the allow-list', async () => {
    await setPolicy({ allowedScopes: ['read'] });
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: org.apiKeyConnectorId, scopes: ['read', 'write'] }),
    );
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe('scope_not_allowed');
    expect(body.error.details.denied).toEqual(['write']);

    const ok = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: org.apiKeyConnectorId, scopes: ['read'] }),
    );
    expect(ok.status).toBe(200);
  });

  it('rejects subject types outside the allow-list', async () => {
    await setPolicy({ allowedSubjects: ['user'] });
    const res = await mintRequest(); // defaults to the app subject
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('subject_not_allowed');
  });

  it('clearing the policy removes all restrictions', async () => {
    await setPolicy(null);
    const res = await mintRequest();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(800_000);
  });
});

describe('installation-scoped rate limits', () => {
  it('returns 429 with Retry-After once the window limit is hit, then recovers', async () => {
    await setPolicy({ rateLimit: { limit: 3, windowSeconds: 1 } });

    // cache hits count too: all requests in the window are metered
    for (let i = 0; i < 3; i++) {
      const res = await mintRequest();
      expect(res.status).toBe(200);
    }
    const limited = await mintRequest();
    expect(limited.status).toBe(429);
    const body = await json(limited);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('retry-after')).toBe(String(body.error.details.retryAfterSeconds));

    // a new window opens after windowSeconds
    await new Promise((r) => setTimeout(r, 1100));
    const recovered = await mintRequest();
    expect(recovered.status).toBe(200);

    await setPolicy(null);
  });

  it('scopes the bucket per installation on oauth connectors', async () => {
    // Two installations on one connector must not share a rate-limit bucket.
    const { connectors, installationGrants, installations, newId } = await import('@connect/db');
    const { storeSeedSecret } = await import('@connect/db/seed-secrets');
    const { encryptSecret, randomToken, secretAad } = await import('@connect/crypto');

    const connectorId = newId.connector();
    await h.deps.db.insert(connectors).values({
      id: connectorId,
      orgId: org.orgId,
      slug: `rl-oauth-${randomToken(6)}`,
      name: 'RL OAuth',
      type: 'oauth2',
      status: 'active',
      ingestKey: randomToken(24),
      clientId: 'client-rl',
      tokenPolicy: { rateLimit: { limit: 2, windowSeconds: 60 } },
      oauthConfig: {
        authorizationEndpoint: 'https://provider.test/authorize',
        tokenEndpoint: 'https://provider.test/token',
        scopesDefault: [],
        pkce: false,
        tokenEndpointAuth: 'post',
      },
    });
    await storeSeedSecret(h.deps.db, h.deps.keyProvider, connectorId, 'oauth_client_secret', 's3');

    const mkInstallation = async (userId: string) => {
      const id = newId.installation();
      await h.deps.db.insert(installations).values({
        id,
        connectorId,
        status: 'active',
        externalAccountId: userId,
        subjectUserId: userId,
      });
      await h.deps.db.insert(installationGrants).values({
        id: newId.grant(),
        installationId: id,
        grantType: 'access_token',
        ciphertext: encryptSecret(
          h.deps.keyProvider,
          secretAad('installation_grants', id, 'access_token'),
          `token-for-${userId}`,
        ),
        scopes: [],
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return id;
    };
    await mkInstallation('user-a');
    await mkInstallation('user-b');

    const mintFor = (userId: string) =>
      h.app.request(
        '/v1/tokens',
        authed(org.pat, { connector: connectorId, subject: { type: 'user', userId } }),
      );

    expect((await mintFor('user-a')).status).toBe(200);
    expect((await mintFor('user-a')).status).toBe(200);
    expect((await mintFor('user-a')).status).toBe(429);
    // user-b's installation has its own bucket
    expect((await mintFor('user-b')).status).toBe(200);
  });
});
