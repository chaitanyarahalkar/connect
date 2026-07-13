import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuth, sessionResolverFor } from './auth/better.js';
import { IssuerService } from './auth/issuer.js';
import { type AuthEnv, authMiddleware, type SessionResolver } from './auth/middleware.js';
import type { AppDeps } from './deps.js';
import { errorHandler } from './errors.js';
import { accessTokenRoutes } from './routes/access-tokens.js';
import { billingRoutes } from './routes/billing.js';
import { connectorRoutes } from './routes/connectors.js';
import { linkRoutes } from './routes/links.js';
import { oauthAuthorizeRoutes, oauthCallbackRoutes } from './routes/oauth.js';
import { oidcRoutes } from './routes/oidc.js';
import { orgRoutes } from './routes/org.js';
import { orgManageRoutes } from './routes/orgs-manage.js';
import { projectRoutes } from './routes/projects.js';
import { tokenRoutes } from './routes/tokens.js';
import {
  connectorTriggerRoutes,
  deliveryRoutes,
  triggerDrainRoutes,
  triggerRoutes,
} from './routes/triggers.js';
import { webhookIngestRoutes } from './webhooks/ingest.js';

export interface BuildAppOptions {
  /** Overrides the default better-auth session resolver (tests). */
  sessionResolver?: SessionResolver;
  /** Extra unauthenticated routes (webhooks) mounted before auth. */
  publicRoutes?: (app: Hono) => void;
}

export function buildApp(deps: AppDeps, opts: BuildAppOptions = {}) {
  const issuer = new IssuerService(deps.db, deps.keyProvider, deps.config.issuer);
  const auth = createAuth(deps);
  const sessionResolver = opts.sessionResolver ?? sessionResolverFor(deps, auth);
  const app = new Hono();

  app.onError(errorHandler);
  app.use(
    '*',
    cors({
      origin: deps.config.dashboardUrl,
      credentials: true,
      allowHeaders: ['content-type', 'authorization', 'x-connect-org'],
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));

  // Public: better-auth, OIDC discovery + client-credentials, oauth callback.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  app.route('/', oidcRoutes(deps, issuer));
  app.route('/', oauthCallbackRoutes(deps));
  app.route('/', webhookIngestRoutes(deps, deps.deliveryQueue));
  opts.publicRoutes?.(app);

  // Everything else under /v1 requires a principal.
  const v1 = new Hono<AuthEnv>();
  v1.use('*', authMiddleware(deps.db, issuer, sessionResolver));
  v1.route('/orgs', orgManageRoutes(deps));
  v1.route('/tokens', tokenRoutes(deps));
  v1.route('/connectors', oauthAuthorizeRoutes(deps));
  v1.route('/connectors', connectorTriggerRoutes(deps));
  v1.route('/connectors', connectorRoutes(deps));
  v1.route('/triggers', triggerDrainRoutes(deps, deps.deliveryQueue));
  v1.route('/triggers', triggerRoutes(deps, deps.deliveryQueue));
  v1.route('/deliveries', deliveryRoutes(deps, deps.deliveryQueue));
  v1.route('/projects', projectRoutes(deps));
  v1.route('/links', linkRoutes(deps));
  v1.route('/access-tokens', accessTokenRoutes(deps));
  v1.route('/billing', billingRoutes(deps));
  v1.route('/', orgRoutes(deps));
  app.route('/v1', v1);

  return { app, issuer, auth };
}
