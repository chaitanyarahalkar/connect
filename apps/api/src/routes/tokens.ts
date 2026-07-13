import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { tokenRequestSchema } from '@connect/shared';
import type { AppDeps } from '../deps.js';
import type { AuthEnv } from '../auth/middleware.js';
import { requestToken } from '../tokens/service.js';

export function tokenRoutes(deps: AppDeps) {
  return new Hono<AuthEnv>().post('/', zValidator('json', tokenRequestSchema), async (c) => {
    const principal = c.get('principal');
    const response = await requestToken(deps, principal, c.req.valid('json'));
    return c.json(response);
  });
}
