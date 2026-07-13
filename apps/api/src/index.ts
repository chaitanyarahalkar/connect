import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDeps } from './deps.js';
import { buildApp } from './app.js';
import { logger } from './logger.js';

const config = loadConfig();
const deps = createDeps(config);
const { app } = buildApp(deps);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(`connect api listening on :${info.port}`);
});
