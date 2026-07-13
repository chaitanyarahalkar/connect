import { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { createDb, type Db } from '@connect/db';
import { EnvKeyProvider, type KeyProvider } from '@connect/crypto';
import type { ApiConfig } from './config.js';
import { createDeliveryQueue, type DeliveryJob } from './webhooks/queue.js';

export interface AppDeps {
  config: ApiConfig;
  db: Db;
  redis: Redis;
  keyProvider: KeyProvider;
  /** Injected fetch for provider + webhook-delivery calls; tests substitute a fake. */
  providerFetch: typeof fetch;
  deliveryQueue: Queue<DeliveryJob>;
  close(): Promise<void>;
}

export function createDeps(config: ApiConfig, overrides: Partial<AppDeps> = {}): AppDeps {
  const { db, sql } = createDb(config.databaseUrl);
  const redis = overrides.redis ?? new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const deliveryQueue = overrides.deliveryQueue ?? createDeliveryQueue(config.redisUrl);
  return {
    config,
    db: overrides.db ?? db,
    redis,
    keyProvider:
      overrides.keyProvider ?? new EnvKeyProvider({ v1: config.masterKey }, 'v1'),
    providerFetch: overrides.providerFetch ?? fetch,
    deliveryQueue,
    close: async () => {
      await deliveryQueue.close();
      await sql.end();
      redis.disconnect();
    },
  };
}
