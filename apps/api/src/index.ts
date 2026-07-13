import { serve } from '@hono/node-server';
import { loadConfig, loadDotEnv } from './config.js';

loadDotEnv();

import { createDb } from '@connect/db';
import { buildApp } from './app.js';
import { createDeps } from './deps.js';
import { createKeyProvider } from './keys/provider.js';
import { logger } from './logger.js';
import { createDeliveryWorker } from './webhooks/queue.js';

const config = loadConfig();
const boot = createDb(config.databaseUrl);
const keyProvider = await createKeyProvider(config, boot.db);
await boot.sql.end();
const deps = createDeps(config, { keyProvider });
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
