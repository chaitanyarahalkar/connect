import { installationGrants } from '@connect/db';
import { buildMockProvider } from '@connect/mock-provider';
import { and, eq, isNull } from 'drizzle-orm';
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

const MOCK_URL = 'http://mock.test';

/** Routes provider-bound fetches to the in-process mock provider app. */
function mockRoutedFetch(mock: ReturnType<typeof buildMockProvider>['app']): typeof fetch {
  return (async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith(MOCK_URL)) {
      return Promise.resolve(mock.request(url.slice(MOCK_URL.length), init as RequestInit));
    }
    throw new Error(`unexpected outbound fetch to ${url}`);
  }) as typeof fetch;
}

let h: TestHarness;
let org: SeededOrg;
let mock: ReturnType<typeof buildMockProvider>;
let connectorId: string;

async function createOAuthConnector(pat: string, slug: string): Promise<string> {
  const res = await h.app.request(
    '/v1/connectors',
    authed(pat, {
      slug,
      name: 'Mock OAuth',
      type: 'oauth2',
      oauthConfig: {
        authorizationEndpoint: `${MOCK_URL}/oauth/authorize`,
        tokenEndpoint: `${MOCK_URL}/oauth/token`,
        revocationEndpoint: `${MOCK_URL}/oauth/revoke`,
        userinfoEndpoint: `${MOCK_URL}/oauth/userinfo`,
        scopesDefault: ['read'],
        pkce: true,
        tokenEndpointAuth: 'post',
        quirksKey: 'mock',
      },
      secrets: { oauthClientId: 'mock-client-id', oauthClientSecret: 'mock-client-secret' },
    }),
  );
  expect(res.status).toBe(201);
  return (await json(res)).connector.id;
}

/** Simulates the browser leg: authorize URL → provider consent → Connect callback. */
async function completeAuthorization(pat: string, connector: string, subjectUserId?: string) {
  const authorize = await h.app.request(
    `/v1/connectors/${connector}/authorize`,
    authed(pat, { subjectUserId }),
  );
  expect(authorize.status).toBe(200);
  const { url } = await json(authorize);

  const consent = await mock.app.request(`${url.slice(MOCK_URL.length)}&auto=1`);
  expect(consent.status).toBe(302);
  const redirect = new URL(consent.headers.get('location')!);

  const callback = await h.app.request(`${redirect.pathname}${redirect.search}`);
  expect(callback.status).toBe(302);
  return callback.headers.get('location')!;
}

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  // 90s tokens: cache TTL = 90s - 60s skew = 30s, long enough to observe a hit
  mock = buildMockProvider({ tokenTtlSeconds: 90, rotateRefreshTokens: true });
  h = await createHarness({ providerFetch: mockRoutedFetch(mock.app) });
  org = await seedOrg(h.deps);
  connectorId = await createOAuthConnector(org.pat, 'mock-oauth');
});

afterAll(async () => {
  await h.cleanup();
});

describe('authorization-code + PKCE flow', () => {
  it('completes authorize → consent → callback and creates an active installation', async () => {
    const dest = await completeAuthorization(org.pat, connectorId);
    expect(dest).toContain('installed=');

    const list = await h.app.request(
      `/v1/connectors/${connectorId}/installations`,
      authed(org.pat),
    );
    const { installations } = await json(list);
    expect(installations).toHaveLength(1);
    expect(installations[0].status).toBe('active');
    expect(installations[0].externalAccountId).toBe('mock-user-1');
    expect(mock.state.stats.exchanges).toBe(1);
  });

  it('rejects a replayed state (single-use)', async () => {
    const authorize = await h.app.request(
      `/v1/connectors/${connectorId}/authorize`,
      authed(org.pat, {}),
    );
    const { url } = await json(authorize);
    const consent = await mock.app.request(`${url.slice(MOCK_URL.length)}&auto=1`);
    const redirect = new URL(consent.headers.get('location')!);

    const first = await h.app.request(`${redirect.pathname}${redirect.search}`);
    expect(first.status).toBe(302);
    const replay = await h.app.request(`${redirect.pathname}${redirect.search}`);
    expect(replay.status).toBe(401);
  });

  it('mints a working provider token via POST /v1/tokens (and caches it)', async () => {
    const res = await h.app.request('/v1/tokens', authed(org.pat, { connector: connectorId }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.tokenType).toBe('bearer');
    expect(body.cached).toBe(false);

    // the token actually works against the provider's protected API
    const data = await mock.app.request('/api/data', {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(data.status).toBe(200);

    const second = await h.app.request('/v1/tokens', authed(org.pat, { connector: connectorId }));
    expect((await json(second)).cached).toBe(true);
  });

  it('refreshes with rotation and keeps exactly one current grant', async () => {
    const refreshesBefore = mock.state.stats.refreshes;
    // different scopes → different cache key → forces a provider refresh
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: connectorId, scopes: ['write'] }),
    );
    expect(res.status).toBe(200);
    expect(mock.state.stats.refreshes).toBe(refreshesBefore + 1);

    const [inst] = (
      await json(
        await h.app.request(`/v1/connectors/${connectorId}/installations`, authed(org.pat)),
      )
    ).installations;
    const current = await h.deps.db
      .select()
      .from(installationGrants)
      .where(
        and(
          eq(installationGrants.installationId, inst.id),
          eq(installationGrants.grantType, 'refresh_token'),
          isNull(installationGrants.supersededById),
        ),
      );
    expect(current).toHaveLength(1);

    const history = await h.deps.db
      .select()
      .from(installationGrants)
      .where(eq(installationGrants.installationId, inst.id));
    expect(history.length).toBeGreaterThan(1); // superseded rows retained
  });

  it('survives concurrent refreshes with rotation enabled (the race)', async () => {
    const refreshesBefore = mock.state.stats.refreshes;
    const scopes = Array.from({ length: 6 }, (_, i) => [`race-${i}`]);
    const results = await Promise.all(
      scopes.map((s) =>
        h.app.request('/v1/tokens', authed(org.pat, { connector: connectorId, scopes: s })),
      ),
    );
    for (const res of results) expect(res.status).toBe(200);
    expect(mock.state.stats.refreshes).toBe(refreshesBefore + 6);

    // after six rotations under concurrency, still exactly one live grant
    const [inst] = (
      await json(
        await h.app.request(`/v1/connectors/${connectorId}/installations`, authed(org.pat)),
      )
    ).installations;
    const current = await h.deps.db
      .select()
      .from(installationGrants)
      .where(
        and(
          eq(installationGrants.installationId, inst.id),
          eq(installationGrants.grantType, 'refresh_token'),
          isNull(installationGrants.supersededById),
        ),
      );
    expect(current).toHaveLength(1);

    // and the next mint still works (the live grant is genuinely valid)
    const after = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: connectorId, scopes: ['post-race'] }),
    );
    expect(after.status).toBe(200);
  });

  it('marks the installation pending when the provider revokes the grant', async () => {
    // wipe provider-side refresh tokens to simulate revocation
    mock.state.refreshTokens.clear();
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: connectorId, scopes: ['after-revoke'] }),
    );
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe('grant_expired');

    const { installations } = await json(
      await h.app.request(`/v1/connectors/${connectorId}/installations`, authed(org.pat)),
    );
    expect(installations[0].status).toBe('pending');

    // re-authorizing revives it
    await completeAuthorization(org.pat, connectorId);
    const revived = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: connectorId, scopes: ['revived'] }),
    );
    expect(revived.status).toBe(200);
  });

  it('supports user-subject authorization and token requests', async () => {
    await completeAuthorization(org.pat, connectorId, 'end-user-42');
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, {
        connector: connectorId,
        subject: { type: 'user', userId: 'end-user-42' },
      }),
    );
    expect(res.status).toBe(200);

    const missing = await h.app.request(
      '/v1/tokens',
      authed(org.pat, {
        connector: connectorId,
        subject: { type: 'user', userId: 'never-authorized' },
      }),
    );
    expect(missing.status).toBe(409);
    expect((await json(missing)).error.code).toBe('user_authorization_required');
  });

  it('exchanges jwt-bearer assertions without an installation', async () => {
    const assertion = [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'federated@corp.test' })).toString('base64url'),
      '',
    ].join('.');
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, {
        connector: connectorId,
        subject: { type: 'jwt-bearer', assertion },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.installationId).toBeNull();
    expect(body.cached).toBe(false);
  });
});
