import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getToken, clearTokenCache, ConnectAuthError } from '@connect/sdk';
import {
  appFetch,
  authed,
  createHarness,
  ensureMigrated,
  json,
  resetState,
  seedOrg,
  type SeededOrg,
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

describe('control plane auth', () => {
  it('rejects missing credentials', async () => {
    const res = await h.app.request('/v1/me');
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects a bogus PAT', async () => {
    const res = await h.app.request('/v1/me', authed('cn_pat_definitely_not_real'));
    expect(res.status).toBe(401);
  });

  it('identifies the org for a valid PAT', async () => {
    const res = await h.app.request('/v1/me', authed(org.pat));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization.id).toBe(org.orgId);
    expect(body.principal.kind).toBe('access_token');
    expect(body.principal.role).toBe('owner');
  });
});

describe('connector CRUD', () => {
  it('creates, lists, and deletes an api_key connector with a write-only secret', async () => {
    const create = await h.app.request(
      '/v1/connectors',
      authed(org.pat, {
        slug: 'my-svc',
        name: 'My Service',
        type: 'api_key',
        secrets: { apiKey: 'sk-abc-123' },
      }),
    );
    expect(create.status).toBe(201);
    const { connector } = await json(create);
    expect(connector.slug).toBe('my-svc');
    // secret never round-trips
    expect(JSON.stringify(connector)).not.toContain('sk-abc-123');

    const list = await h.app.request('/v1/connectors', authed(org.pat));
    const { connectors } = await json(list);
    expect(connectors.map((c: { slug: string }) => c.slug)).toContain('my-svc');

    const del = await h.app.request(`/v1/connectors/${connector.id}`, {
      ...authed(org.pat),
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
  });

  it('rejects duplicate slugs with a conflict', async () => {
    const payload = { slug: 'dupe-svc', name: 'Dupe', type: 'api_key' as const };
    await h.app.request('/v1/connectors', authed(org.pat, payload));
    const res = await h.app.request('/v1/connectors', authed(org.pat, payload));
    expect(res.status).toBe(409);
  });
});

describe('POST /v1/tokens with api_key connector', () => {
  it('returns the stored key with a policy TTL and meters usage', async () => {
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: org.apiKeyConnectorId }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.token).toBe('secret-api-key-value');
    expect(body.tokenType).toBe('api_key');
    expect(body.cached).toBe(false);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const second = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: org.apiKeyConnectorId }),
    );
    const body2 = await json(second);
    expect(body2.token).toBe('secret-api-key-value');
    expect(body2.cached).toBe(true);

    const usage = await h.app.request('/v1/usage', authed(org.pat));
    const { daily } = await json(usage);
    const tokenRequests = daily
      .filter((d: { kind: string }) => d.kind === 'token_request')
      .reduce((sum: number, d: { total: number }) => sum + d.total, 0);
    expect(tokenRequests).toBeGreaterThanOrEqual(2);
  });

  it('resolves the connector by slug too', async () => {
    const list = await h.app.request('/v1/connectors', authed(org.pat));
    const { connectors } = await json(list);
    const slug = connectors.find((c: { id: string }) => c.id === org.apiKeyConnectorId)!.slug;
    const res = await h.app.request('/v1/tokens', authed(org.pat, { connector: slug }));
    expect(res.status).toBe(200);
  });

  it('404s for unknown connectors', async () => {
    const res = await h.app.request('/v1/tokens', authed(org.pat, { connector: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('rejects user subjects on api_key connectors', async () => {
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, {
        connector: org.apiKeyConnectorId,
        subject: { type: 'user', userId: 'u1' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe('unsupported_subject');
  });

  it('cannot reach another org’s connector', async () => {
    const other = await seedOrg(h.deps, 'other');
    const res = await h.app.request(
      '/v1/tokens',
      authed(other.pat, { connector: org.apiKeyConnectorId }),
    );
    expect(res.status).toBe(404);
  });
});

describe('SDK round trip', () => {
  it('getToken() fetches via PAT and caches in-process', async () => {
    clearTokenCache();
    const fetchViaApp = appFetch(h.app);

    let calls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      calls++;
      return fetchViaApp(input, init);
    };

    const token = await getToken(
      { connector: org.apiKeyConnectorId },
      { baseUrl: '', auth: org.pat, fetch: countingFetch },
    );
    expect(token.token).toBe('secret-api-key-value');
    expect(token.tokenType).toBe('api_key');
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const again = await getToken(
      { connector: org.apiKeyConnectorId },
      { baseUrl: '', auth: org.pat, fetch: countingFetch },
    );
    expect(again.token).toBe(token.token);
    expect(calls).toBe(1); // second call served from the SDK cache

    clearTokenCache();
  });

  it('surfaces typed auth errors', async () => {
    clearTokenCache();
    const fetchViaApp = appFetch(h.app);
    await expect(
      getToken(
        { connector: org.apiKeyConnectorId },
        { baseUrl: '', auth: 'cn_pat_wrong', fetch: fetchViaApp },
      ),
    ).rejects.toBeInstanceOf(ConnectAuthError);
    clearTokenCache();
  });
});
