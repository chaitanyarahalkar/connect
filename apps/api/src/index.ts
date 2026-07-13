import { serve } from '@hono/node-server';
import { loadConfig, loadDotEnv } from './config.js';

loadDotEnv();
import { createDeps } from './deps.js';
import { buildApp } from './app.js';
import { createDeliveryWorker } from './webhooks/queue.js';
import { logger } from './logger.js';

const config = loadConfig();
const deps = createDeps(config);
const { app } = buildApp(deps);
const worker = createDeliveryWorker(deps);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(`connect api listening on :${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void worker.close().then(() => deps.close().then(() => process.exit(0)));
  });
}
