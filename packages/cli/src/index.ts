import { Command } from 'commander';
import { intro, outro, password, text, select, isCancel } from '@clack/prompts';
import { ConnectClient, getToken } from '@connect/sdk';
import { loadCliConfig, requireCliConfig, saveCliConfig } from './config.js';

const program = new Command('connect').description('Connect CLI — manage connectors and request tokens');

function client(): ConnectClient {
  const cfg = requireCliConfig();
  return new ConnectClient({ baseUrl: cfg.apiUrl, auth: cfg.token });
}

function fail(err: unknown): never {
  const e = err as { code?: string; message?: string };
  console.error(`error${e.code ? ` [${e.code}]` : ''}: ${e.message ?? String(err)}`);
  process.exit(1);
}

program
  .command('login')
  .description('authenticate with a personal access token')
  .option('--api-url <url>', 'Connect API base URL', process.env.CONNECT_API_URL ?? 'http://localhost:4000')
  .action(async (opts: { apiUrl: string }) => {
    intro('connect login');
    const token = await password({ message: `paste an access token for ${opts.apiUrl} (cn_pat_…)` });
    if (isCancel(token) || !token) process.exit(1);
    const probe = new ConnectClient({ baseUrl: opts.apiUrl, auth: token });
    const me = await probe
      .get<{ organization: { name: string; slug: string } }>('/v1/me')
      .catch(fail);
    saveCliConfig({ apiUrl: opts.apiUrl, token });
    outro(`logged in to ${me.organization.name} (${me.organization.slug})`);
  });

program
  .command('whoami')
  .description('show the current identity')
  .action(async () => {
    const me = await client()
      .get<{ principal: { kind: string; role: string }; organization: { name: string; slug: string } }>('/v1/me')
      .catch(fail);
    console.log(`${me.organization.name} (${me.organization.slug}) — ${me.principal.kind}, role ${me.principal.role}`);
  });

const connectors = program.command('connectors').description('manage connectors');

connectors
  .command('list')
  .action(async () => {
    const { connectors: rows } = await client()
      .get<{ connectors: { slug: string; name: string; type: string; status: string; id: string }[] }>('/v1/connectors')
      .catch(fail);
    if (!rows.length) return console.log('no connectors yet — `connect connectors create`');
    for (const c of rows) console.log(`${c.slug.padEnd(24)} ${c.type.padEnd(8)} ${c.status.padEnd(9)} ${c.id}`);
  });

connectors
  .command('create')
  .description('create a connector interactively')
  .action(async () => {
    intro('new connector');
    const name = await text({ message: 'display name' });
    if (isCancel(name)) process.exit(1);
    const slug = await text({
      message: 'slug',
      initialValue: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    });
    if (isCancel(slug)) process.exit(1);
    const type = await select({
      message: 'type',
      options: [
        { value: 'api_key', label: 'API key' },
        { value: 'oauth2', label: 'Custom OAuth 2.0 / OIDC' },
      ],
    });
    if (isCancel(type)) process.exit(1);

    const body: Record<string, unknown> = { name, slug, type };
    if (type === 'api_key') {
      const apiKey = await password({ message: 'API key to store (encrypted at rest)' });
      if (isCancel(apiKey)) process.exit(1);
      body.secrets = { apiKey };
    } else {
      const issuer = await text({ message: 'authorization endpoint URL' });
      const tokenEndpoint = await text({ message: 'token endpoint URL' });
      const clientId = await text({ message: 'oauth client id' });
      const clientSecret = await password({ message: 'oauth client secret' });
      if ([issuer, tokenEndpoint, clientId, clientSecret].some(isCancel)) process.exit(1);
      body.oauthConfig = {
        authorizationEndpoint: issuer,
        tokenEndpoint,
        scopesDefault: [],
        pkce: true,
        tokenEndpointAuth: 'post',
      };
      body.secrets = { oauthClientId: clientId, oauthClientSecret: clientSecret };
    }
    const { connector } = await client()
      .post<{ connector: { id: string; slug: string } }>('/v1/connectors', body)
      .catch(fail);
    outro(`created ${connector.slug} (${connector.id})`);
  });

program
  .command('link')
  .description('link a connector to a project')
  .argument('<project>', 'project id or slug')
  .argument('<connector>', 'connector id or slug')
  .option('--env <envs>', 'comma-separated environments', 'production')
  .action(async (project: string, connector: string, opts: { env: string }) => {
    await client()
      .post('/v1/links', { project, connector, environments: opts.env.split(',') })
      .catch(fail);
    console.log(`linked ${connector} → ${project} [${opts.env}]`);
  });

program
  .command('authorize')
  .description('start an OAuth authorization for a connector')
  .argument('<connector>')
  .option('--user <userId>', 'authorize as a user subject')
  .action(async (connector: string, opts: { user?: string }) => {
    const { url } = await client()
      .post<{ url: string }>(`/v1/connectors/${encodeURIComponent(connector)}/authorize`, {
        subjectUserId: opts.user,
      })
      .catch(fail);
    console.log('open this URL to authorize:');
    console.log(url);
  });

program
  .command('installations')
  .description('list a connector’s installations')
  .argument('<connector>')
  .action(async (connector: string) => {
    const { installations } = await client()
      .get<{ installations: { id: string; status: string; externalAccountName: string | null; externalAccountId: string | null }[] }>(
        `/v1/connectors/${encodeURIComponent(connector)}/installations`,
      )
      .catch(fail);
    if (!installations.length) return console.log('no installations — run `connect authorize`');
    for (const i of installations) {
      console.log(`${i.id}  ${i.status.padEnd(8)} ${i.externalAccountName ?? i.externalAccountId ?? ''}`);
    }
  });

program
  .command('token')
  .description('request a short-lived provider token (smoke test)')
  .argument('<connector>')
  .option('--scopes <scopes>', 'comma-separated scopes')
  .option('--installation <id>')
  .option('--user <userId>', 'user subject')
  .option('--json', 'print the full response as JSON')
  .action(async (connector: string, opts: { scopes?: string; installation?: string; user?: string; json?: boolean }) => {
    const cfg = requireCliConfig();
    const result = await getToken(
      {
        connector,
        scopes: opts.scopes?.split(','),
        installationId: opts.installation,
        subject: opts.user ? { type: 'user', userId: opts.user } : { type: 'app' },
      },
      { baseUrl: cfg.apiUrl, auth: cfg.token },
    ).catch(fail);
    if (opts.json) {
      console.log(JSON.stringify({ ...result, expiresAt: result.expiresAt.toISOString() }, null, 2));
    } else {
      console.log(result.token);
      console.error(`expires ${result.expiresAt.toISOString()}  scopes=[${result.scopes.join(' ')}]`);
    }
  });

program
  .command('projects')
  .description('list projects')
  .action(async () => {
    const { projects } = await client()
      .get<{ projects: { id: string; slug: string; name: string }[] }>('/v1/projects')
      .catch(fail);
    for (const p of projects) console.log(`${p.slug.padEnd(24)} ${p.name.padEnd(24)} ${p.id}`);
  });

program.parseAsync().catch(fail);
