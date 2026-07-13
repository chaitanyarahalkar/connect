import { and, eq, or } from 'drizzle-orm';
import { connectors, installations, newId, projectLinks, tokenIssuances } from '@connect/db';
import { ConnectError, type TokenRequest, type TokenResponse } from '@connect/shared';
import type { AppDeps } from '../deps.js';
import type { Principal } from '../auth/principal.js';
import { meterUsage } from '../audit.js';
import { TokenCache, cacheKey, type CachedToken } from './cache.js';
import { singleFlight } from './lock.js';
import { mintApiKeyToken, type ConnectorRow, type InstallationRow, type Minter } from './minters.js';
import { mintOAuth2Token } from './oauth2-minter.js';
import { mintGithubToken } from './github-minter.js';

const minters: Record<ConnectorRow['type'], Minter> = {
  api_key: mintApiKeyToken,
  oauth2: mintOAuth2Token,
  github: mintGithubToken,
  // Slack minting is plain OAuth refresh; the slack-ness lives in quirks.
  slack: mintOAuth2Token,
};

export async function requestToken(
  deps: AppDeps,
  principal: Principal,
  req: TokenRequest,
): Promise<TokenResponse> {
  const connector = await resolveConnector(deps, principal.orgId, req.connector);
  await authorizeRequest(deps, principal, connector);
  const installation = await resolveInstallation(deps, connector, req);

  const scopes = req.scopes ?? [];
  const key = cacheKey({
    connectorId: connector.id,
    installationId: installation?.id ?? null,
    subject: req.subject,
    scopes,
    resource: req.resource,
  });
  const cache = new TokenCache(deps.redis, deps.keyProvider);

  let minted = false;
  let result: CachedToken;

  if (key) {
    const cached = await cache.get(key);
    if (cached) {
      result = cached;
    } else {
      const flight = await singleFlight(
        deps.redis,
        key,
        () => cache.get(key),
        async () => {
          const fresh = await mint(deps, connector, installation, req, scopes);
          await cache.set(key, fresh);
          return fresh;
        },
      );
      result = flight.value;
      minted = flight.minted;
    }
  } else {
    // jwt-bearer: never cached
    result = await mint(deps, connector, installation, req, scopes);
    minted = true;
  }

  await recordIssuance(deps, principal, connector, installation, req, result, !minted);

  return {
    token: result.token,
    tokenType: result.tokenType,
    expiresAt: result.expiresAt,
    scopes: result.scopes,
    connectorId: connector.id,
    installationId: installation?.id ?? null,
    cached: !minted,
  };
}

async function mint(
  deps: AppDeps,
  connector: ConnectorRow,
  installation: InstallationRow | null,
  req: TokenRequest,
  scopes: string[],
): Promise<CachedToken> {
  const minter = minters[connector.type];
  if (!minter) {
    throw new ConnectError('provider_error', `connector type ${connector.type} is not supported yet`);
  }
  return minter({
    deps,
    connector,
    installation,
    subject: req.subject,
    scopes,
    resource: req.resource,
    authorizationDetails: req.authorizationDetails,
  });
}

async function resolveConnector(
  deps: AppDeps,
  orgId: string,
  slugOrId: string,
): Promise<ConnectorRow> {
  const [row] = await deps.db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        or(eq(connectors.id, slugOrId), eq(connectors.slug, slugOrId)),
      ),
    )
    .limit(1);
  if (!row) throw new ConnectError('not_found', `connector "${slugOrId}" not found`);
  if (row.status !== 'active') {
    throw new ConnectError('connector_disabled', `connector "${row.slug}" is disabled`);
  }
  return row;
}

async function authorizeRequest(
  deps: AppDeps,
  principal: Principal,
  connector: ConnectorRow,
): Promise<void> {
  if (principal.kind !== 'workload') return; // users/PATs: org membership suffices (playground, CLI)

  const [link] = await deps.db
    .select()
    .from(projectLinks)
    .where(
      and(
        eq(projectLinks.projectId, principal.projectId),
        eq(projectLinks.connectorId, connector.id),
      ),
    )
    .limit(1);
  if (!link) {
    throw new ConnectError('link_not_found', 'calling project is not linked to this connector', {
      projectId: principal.projectId,
      connector: connector.slug,
    });
  }
  if (!link.environments.includes(principal.environment)) {
    throw new ConnectError(
      'environment_not_enabled',
      `project link does not include the ${principal.environment} environment`,
      { environments: link.environments },
    );
  }
}

async function resolveInstallation(
  deps: AppDeps,
  connector: ConnectorRow,
  req: TokenRequest,
): Promise<InstallationRow | null> {
  if (connector.type === 'api_key') return null;

  // jwt-bearer exchanges carry their own identity; an installation is optional
  if (req.subject.type === 'jwt-bearer' && !req.installationId) return null;

  if (req.installationId) {
    const [row] = await deps.db
      .select()
      .from(installations)
      .where(and(eq(installations.id, req.installationId), eq(installations.connectorId, connector.id)))
      .limit(1);
    if (!row) throw new ConnectError('not_found', `installation ${req.installationId} not found`);
    if (row.status === 'revoked') {
      throw new ConnectError('installation_revoked', 'installation has been revoked');
    }
    return row;
  }

  // user subjects resolve to the installation created when that user authorized
  if (req.subject.type === 'user') {
    const [row] = await deps.db
      .select()
      .from(installations)
      .where(
        and(
          eq(installations.connectorId, connector.id),
          eq(installations.subjectUserId, req.subject.userId),
          eq(installations.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) {
      throw new ConnectError(
        'user_authorization_required',
        `user ${req.subject.userId} has not authorized this connector`,
      );
    }
    return row;
  }

  const active = await deps.db
    .select()
    .from(installations)
    .where(and(eq(installations.connectorId, connector.id), eq(installations.status, 'active')))
    .limit(2);
  if (active.length === 0) {
    throw new ConnectError('installation_required', 'no active installation for this connector');
  }
  if (active.length > 1) {
    throw new ConnectError(
      'installation_ambiguous',
      'multiple installations exist; pass installationId',
    );
  }
  return active[0]!;
}

async function recordIssuance(
  deps: AppDeps,
  principal: Principal,
  connector: ConnectorRow,
  installation: InstallationRow | null,
  req: TokenRequest,
  result: CachedToken,
  cacheHit: boolean,
): Promise<void> {
  const projectId = principal.kind === 'workload' ? principal.projectId : null;
  await deps.db.insert(tokenIssuances).values({
    id: newId.issuance(),
    orgId: principal.orgId,
    projectId,
    connectorId: connector.id,
    installationId: installation?.id ?? null,
    subjectType: req.subject.type === 'jwt-bearer' ? 'jwt_bearer' : req.subject.type,
    scopes: result.scopes,
    cacheHit,
    expiresAt: new Date(result.expiresAt),
    requestedBy: principal.kind === 'workload' ? 'oidc' : principal.kind === 'access_token' ? 'pat' : 'session',
  });
  await meterUsage(deps.db, {
    orgId: principal.orgId,
    projectId,
    connectorId: connector.id,
    kind: 'token_request',
  });
}
