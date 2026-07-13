import { generateKeyPairSync } from 'node:crypto';
import { presetFor, quirksFor } from '@connect/connectors';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuthorizationUrl } from '../src/oauth/engine.js';
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

describe('google preset', () => {
  it('is registered with google quirks', () => {
    const preset = presetFor('google');
    expect(preset).toBeDefined();
    expect(preset!.oauthConfig!.quirksKey).toBe('google');
    expect(preset!.oauthConfig!.pkce).toBe(true);
  });

  it('requests offline access so a refresh token is issued', () => {
    const preset = presetFor('google')!;
    const url = new URL(
      buildAuthorizationUrl(
        { ...preset.oauthConfig!, scopesDefault: preset.oauthConfig!.scopesDefault },
        {
          clientId: 'cid',
          redirectUri: 'https://connect.test/cb',
          state: 's',
          scopes: ['openid', 'email'],
          codeChallenge: 'challenge',
        },
      ),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
  });
});

describe('salesforce preset', () => {
  it('labels installations from the identity URL in the token response', async () => {
    const quirks = quirksFor('salesforce');
    const fetchImpl = (async (input: unknown) => {
      expect(String(input)).toBe('https://login.salesforce.com/id/00Dxx0000001gEREAY/005xx');
      return Response.json({ username: 'svc@acme.com', display_name: 'Svc User' });
    }) as typeof fetch;
    const identity = await quirks.identify!(
      {
        accessToken: 'at',
        raw: { id: 'https://login.salesforce.com/id/00Dxx0000001gEREAY/005xx' },
      },
      presetFor('salesforce')!.oauthConfig!,
      fetchImpl,
    );
    expect(identity.externalAccountId).toBe('00Dxx0000001gEREAY');
    expect(identity.externalAccountName).toBe('svc@acme.com');
  });

  it('applies a default expiry since salesforce omits expires_in', () => {
    expect(quirksFor('salesforce').defaultExpirySeconds).toBe(7200);
  });
});

describe('snowflake connector (JWT exchange)', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let connectorId: string;

  it('creates a snowflake connector with providerConfig + private key', async () => {
    const res = await h.app.request(
      '/v1/connectors',
      authed(org.pat, {
        slug: 'snowflake-wh',
        name: 'Snowflake',
        type: 'snowflake',
        providerConfig: { account: 'xy12345.us-east-1', username: 'svc_etl', tokenTtlSeconds: 900 },
        secrets: { snowflakePrivateKey: privateKeyPem },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    connectorId = body.connector.id;
    expect(body.connector.type).toBe('snowflake');
    expect(body.connector.providerConfig).toMatchObject({ account: 'xy12345.us-east-1' });
  });

  it('rejects creation without account/username', async () => {
    const res = await h.app.request(
      '/v1/connectors',
      authed(org.pat, { slug: 'snowflake-bad', name: 'Bad', type: 'snowflake' }),
    );
    expect(res.status).toBe(400);
  });

  it('mints a KEYPAIR_JWT locally for app subjects', async () => {
    const res = await h.app.request('/v1/tokens', authed(org.pat, { connector: connectorId }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.tokenType).toBe('bearer');
    expect(body.installationId).toBeNull();

    const claims = decodeJwt(body.token);
    expect(claims.sub).toBe('XY12345.SVC_ETL');
    expect(String(claims.iss)).toMatch(/^XY12345\.SVC_ETL\.SHA256:/);
    // configured 900s TTL
    const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(900_000);
    expect(ttlMs).toBeGreaterThan(800_000);
  });

  it('rejects user subjects', async () => {
    const res = await h.app.request(
      '/v1/tokens',
      authed(org.pat, { connector: connectorId, subject: { type: 'user', userId: 'u1' } }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('unsupported_subject');
  });

  it('serves the second request from cache', async () => {
    const res = await h.app.request('/v1/tokens', authed(org.pat, { connector: connectorId }));
    expect(res.status).toBe(200);
    expect((await json(res)).cached).toBe(true);
  });
});
