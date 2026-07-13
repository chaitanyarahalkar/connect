import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppDeps } from './deps.js';
import { errorHandler } from './errors.js';
import { IssuerService } from './auth/issuer.js';
import { authMiddleware, type AuthEnv, type SessionResolver } from './auth/middleware.js';
import { oidcRoutes } from './routes/oidc.js';
import { oauthAuthorizeRoutes, oauthCallbackRoutes } from './routes/oauth.js';
import { tokenRoutes } from './routes/tokens.js';
import { connectorRoutes } from './routes/connectors.js';
import { projectRoutes } from './routes/projects.js';
import { linkRoutes } from './routes/links.js';
import { accessTokenRoutes } from './routes/access-tokens.js';
import { orgRoutes } from './routes/org.js';

export interface BuildAppOptions {
  /** Resolves better-auth dashboard sessions; wired up with the dashboard milestone. */
  sessionResolver?: SessionResolver;
  /** Extra unauthenticated routes (better-auth handler, webhooks) mounted before auth. */
  publicRoutes?: (app: Hono) => void;
}

export function buildApp(deps: AppDeps, opts: BuildAppOptions = {}) {
  const issuer = new IssuerService(deps.db, deps.keyProvider, deps.config.issuer);
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

  // Public: OIDC discovery + client-credentials, oauth callback, caller-provided routes.
  app.route('/', oidcRoutes(deps, issuer));
  app.route('/', oauthCallbackRoutes(deps));
  opts.publicRoutes?.(app);

  // Everything else under /v1 requires a principal.
  const v1 = new Hono<AuthEnv>();
  v1.use('*', authMiddleware(deps.db, issuer, opts.sessionResolver));
  v1.route('/tokens', tokenRoutes(deps));
  v1.route('/connectors', oauthAuthorizeRoutes(deps));
  v1.route('/connectors', connectorRoutes(deps));
  v1.route('/projects', projectRoutes(deps));
  v1.route('/links', linkRoutes(deps));
  v1.route('/access-tokens', accessTokenRoutes(deps));
  v1.route('/', orgRoutes(deps));
  app.route('/v1', v1);

  return { app, issuer };
}
