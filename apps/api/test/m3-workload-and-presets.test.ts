import { generateKeyPairSync } from 'node:crypto';
import { clearTokenCache, getToken } from '@connect/sdk';
import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appFetch,
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

// RSA keypair standing in for a GitHub App key
const { publicKey: ghPublicPem, privateKey: ghPrivatePem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** Captures GitHub App token requests and validates the app JWT. */
const githubCalls: { installationId: string; body: Record<string, unknown>; issuer?: string }[] =
  [];
const githubFetch: typeof fetch = (async (input: unknown, init?: unknown) => {
  const url = String(input);
  const m = url.match(/api\.github\.com\/app\/installations\/(\w+)\/access_tokens/);
  if (m) {
    const req = (init ?? {}) as RequestInit;
    const jwt = String((req.headers as Record<string, string>).authorization).replace(
      'Bearer ',
      '',
    );
    const key = await importSPKI(ghPublicPem, 'RS256');
    const { payload } = await jwtVerify(jwt, key);
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');
    githubCalls.push({
      installationId: m[1]!,
      body: JSON.parse(String(req.body ?? '{}')),
      issuer: payload.iss,
    });
    return new Response(
      JSON.stringify({
        token: 'ghs_installation_token',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }
  throw new Error(`unexpected outbound fetch to ${url}`);
}) as typeof fetch;

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness({ providerFetch: githubFetch });
  org = await seedOrg(h.deps);
});

afterAll(async () => {
  await h.cleanup();
});

async function mintWorkloadJwt(environment: string): Promise<string> {
  const client = await json(
    await h.app.request(`/v1/projects/${org.projectId}/clients`, authed(org.pat, { environment })),
  );
  const res = await h.app.request('/v1/oidc/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.client.clientId,
      client_secret: client.client.clientSecret,
    }),
  });
  expect(res.status).toBe(200);
  return (await json(res)).access_token;
}

describe('workload identity (OIDC)', () => {
  it('serves discovery and JWKS', async () => {
    const disc = await json(await h.app.request('/.well-known/openid-configuration'));
    expect(disc.issuer).toBe('http://connect.test');
    const jwks = await json(await h.app.request('/.well-known/jwks.json'));
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].alg).toBe('ES256');
  });

  it('rejects bad client credentials', async () => {
    const res = await h.app.request('/v1/oidc/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'pc_nope',
        client_secret: 'pcs_nope',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('lets a linked workload mint tokens for its environment', async () => {
    const jwt = await mintWorkloadJwt('production');
    const res = await h.app.request(
      '/v1/tokens',
      authed(jwt, { connector: org.apiKeyConnectorId }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).token).toBe('secret-api-key-value');
  });

  it('rejects environments missing from the project link', async () => {
    // seedOrg links production+development only
    const jwt = await mintWorkloadJwt('preview');
    const res = await h.app.request(
      '/v1/tokens',
      authed(jwt, { connector: org.apiKeyConnectorId }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('environment_not_enabled');
  });

  it('rejects connectors the project is not linked to', async () => {
    const created = await json(
      await h.app.request(
        '/v1/connectors',
        authed(org.pat, {
          slug: 'unlinked-svc',
          name: 'Unlinked',
          type: 'api_key',
          secrets: { apiKey: 'k' },
        }),
      ),
    );
    const jwt = await mintWorkloadJwt('production');
    const res = await h.app.request('/v1/tokens', authed(jwt, { connector: created.connector.id }));
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('link_not_found');
  });

  it('blocks workloads from the control plane', async () => {
    const jwt = await mintWorkloadJwt('production');
    const res = await h.app.request('/v1/connectors', authed(jwt));
    expect(res.status).toBe(403);
  });

  it('SDK self-mints a workload JWT from client credentials', async () => {
    clearTokenCache();
    const client = await json(
      await h.app.request(
        `/v1/projects/${org.projectId}/clients`,
        authed(org.pat, { environment: 'production' }),
      ),
    );
    process.env.CONNECT_CLIENT_ID = client.client.clientId;
    process.env.CONNECT_CLIENT_SECRET = client.client.clientSecret;
    try {
      const token = await getToken(
        { connector: org.apiKeyConnectorId },
        { baseUrl: '', fetch: appFetch(h.app) },
      );
      expect(token.token).toBe('secret-api-key-value');
    } finally {
      delete process.env.CONNECT_CLIENT_ID;
      delete process.env.CONNECT_CLIENT_SECRET;
      clearTokenCache();
    }
  });
});

describe('GitHub App connector', () => {
  let connectorId: string;

  it('creates the connector with app credentials and a registered installation', async () => {
    const res = await h.app.request(
      '/v1/connectors',
      authed(org.pat, {
        slug: 'github-app',
        name: 'GitHub',
        type: 'github',
        oauthConfig: {
          authorizationEndpoint: 'https://github.com/login/oauth/authorize',
          tokenEndpoint: 'https://github.com/login/oauth/access_token',
          scopesDefault: [],
          pkce: false,
          tokenEndpointAuth: 'post',
          quirksKey: 'github',
        },
        secrets: {
          githubAppId: '314159',
          githubAppPrivateKey: ghPrivatePem,
          oauthClientId: 'Iv1.mockclient',
          oauthClientSecret: 'ghsecret',
        },
      }),
    );
    expect(res.status).toBe(201);
    connectorId = (await json(res)).connector.id;

    const inst = await h.app.request(
      `/v1/connectors/${connectorId}/installations`,
      authed(org.pat, { externalAccountId: '9001', externalAccountName: 'acme-org' }),
    );
    expect(inst.status).toBe(201);
  });

  it('mints an installation access token via a signed app JWT', async () => {
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, {
        connector: connectorId,
        authorizationDetails: [{ repositories: ['api', 'web'], permissions: { contents: 'read' } }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.token).toBe('ghs_installation_token');
    expect(body.tokenType).toBe('bearer');

    const call = githubCalls.at(-1)!;
    expect(call.installationId).toBe('9001');
    expect(call.issuer).toBe('314159'); // app JWT iss = app id
    expect(call.body.repositories).toEqual(['api', 'web']);
    expect(call.body.permissions).toEqual({ contents: 'read' });
  });
});
