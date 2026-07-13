import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, ensureMigrated, json, resetState, type TestHarness } from './helpers.js';

let h: TestHarness;
let cookie = '';

function withSession(body?: unknown, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

beforeAll(async () => {
  await ensureMigrated();
  await resetState();
  h = await createHarness();
});

afterAll(async () => {
  await h.cleanup();
});

describe('dashboard session flow', () => {
  it('signs up via better-auth and gets a session cookie', async () => {
    const res = await h.app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Dana Dev',
        email: 'dana@example.test',
        password: 'super-secure-pw-1',
      }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    cookie = setCookie!.split(';')[0]!;
  });

  it('starts org-less: /v1/me has no organization', async () => {
    const me = await json(await h.app.request('/v1/me', withSession()));
    expect(me.principal.kind).toBe('user');
    expect(me.organization).toBeNull();
  });

  it('creates an org through onboarding and becomes its owner', async () => {
    const res = await h.app.request(
      '/v1/orgs',
      withSession({ name: 'Dana Corp', slug: 'dana-corp' }),
    );
    expect(res.status).toBe(201);
    const { organization } = await json(res);
    expect(organization.role).toBe('owner');

    const me = await json(
      await h.app.request('/v1/me', withSession(undefined, { 'x-connect-org': 'dana-corp' })),
    );
    expect(me.organization.slug).toBe('dana-corp');
    expect(me.principal.role).toBe('owner');
  });

  it('runs the control plane on a session cookie: connector + PAT creation', async () => {
    const created = await h.app.request(
      '/v1/connectors',
      withSession(
        { slug: 'sess-svc', name: 'Session Service', type: 'api_key', secrets: { apiKey: 'k1' } },
        { 'x-connect-org': 'dana-corp' },
      ),
    );
    expect(created.status).toBe(201);

    const pat = await h.app.request(
      '/v1/access-tokens',
      withSession({ name: 'ci token' }, { 'x-connect-org': 'dana-corp' }),
    );
    expect(pat.status).toBe(201);
    const { token } = await json(pat);
    expect(token.plaintext).toMatch(/^cn_pat_/);

    // the PAT works standalone
    const viaPat = await h.app.request('/v1/me', {
      headers: { authorization: `Bearer ${token.plaintext}` },
    });
    expect((await json(viaPat)).organization.slug).toBe('dana-corp');
  });

  it('denies access to orgs the user is not a member of', async () => {
    const res = await h.app.request(
      '/v1/connectors',
      withSession(undefined, { 'x-connect-org': 'some-other-org' }),
    );
    expect(res.status).toBe(401);
  });
});
