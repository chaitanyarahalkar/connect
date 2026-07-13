import { Redis } from 'ioredis';
import { createDb, type Db } from '@connect/db';
import { EnvKeyProvider, type KeyProvider } from '@connect/crypto';
import type { ApiConfig } from './config.js';

export interface AppDeps {
  config: ApiConfig;
  db: Db;
  redis: Redis;
  keyProvider: KeyProvider;
  /** Injected fetch for provider calls; tests substitute a fake. */
  providerFetch: typeof fetch;
  close(): Promise<void>;
}

export function createDeps(config: ApiConfig, overrides: Partial<AppDeps> = {}): AppDeps {
  const { db, sql } = createDb(config.databaseUrl);
  const redis = overrides.redis ?? new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  return {
    config,
    db: overrides.db ?? db,
    redis,
    keyProvider:
      overrides.keyProvider ?? new EnvKeyProvider({ v1: config.masterKey }, 'v1'),
    providerFetch: overrides.providerFetch ?? fetch,
    close: async () => {
      await sql.end();
      redis.disconnect();
    },
  };
}
