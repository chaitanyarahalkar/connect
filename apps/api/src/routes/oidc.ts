import { verifySecret } from '@connect/crypto';
import { projectClients, projects } from '@connect/db';
import { ConnectError, oidcTokenRequestSchema } from '@connect/shared';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { IssuerService } from '../auth/issuer.js';
import type { AppDeps } from '../deps.js';

/** Public (unauthenticated) issuer endpoints: discovery, JWKS, client-credentials. */
export function oidcRoutes(deps: AppDeps, issuer: IssuerService) {
  const app = new Hono();

  app.get('/.well-known/openid-configuration', (c) => c.json(issuer.openidConfiguration()));
  app.get('/.well-known/jwks.json', async (c) => c.json(await issuer.jwks()));

  app.post('/v1/oidc/token', zValidator('form', oidcTokenRequestSchema), async (c) => {
    const input = c.req.valid('form');
    const [client] = await deps.db
      .select()
      .from(projectClients)
      .where(and(eq(projectClients.clientId, input.client_id), isNull(projectClients.revokedAt)))
      .limit(1);
    if (!client || !verifySecret(input.client_secret, client.clientSecretHash)) {
      throw new ConnectError('unauthorized', 'invalid client credentials');
    }
    const [project] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, client.projectId))
      .limit(1);
    if (!project) throw new ConnectError('unauthorized', 'project no longer exists');

    const { token, expiresIn } = await issuer.mintWorkloadToken({
      orgId: project.orgId,
      projectId: project.id,
      environment: client.environment,
    });
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
  });

  return app;
}
