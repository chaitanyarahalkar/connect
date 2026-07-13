import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal .env loader (repo root), used in dev so `pnpm dev` just works. */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && env[m[1]!] === undefined) {
      env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
}

export type KeyProviderKind = 'env' | 'aws-kms' | 'gcp-kms';

export interface ApiConfig {
  databaseUrl: string;
  redisUrl: string;
  /** Which KeyProvider wraps DEKs: env master key(s) or a remote KMS. */
  keyProvider: KeyProviderKind;
  /** Env-provider KEKs by version ({ v1: <base64>, … }). Empty when a KMS is used. */
  masterKeys: Record<string, string>;
  /** Version used for new wraps by the env provider. */
  masterKeyVersion: string;
  /** Remote KMS key (ARN / resource name) when keyProvider is aws-kms/gcp-kms. */
  kmsKeyId?: string;
  issuer: string;
  port: number;
  dashboardUrl: string;
  betterAuthSecret: string;
  /** Policy TTL for api_key connector tokens (seconds). */
  apiKeyTokenTtl: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`missing required env var ${name}`);
    return v;
  };
  const keyProvider = (env.CONNECT_KEY_PROVIDER ?? 'env') as KeyProviderKind;
  if (!['env', 'aws-kms', 'gcp-kms'].includes(keyProvider)) {
    throw new Error(`CONNECT_KEY_PROVIDER must be env, aws-kms or gcp-kms, got "${keyProvider}"`);
  }
  const masterKeys: Record<string, string> =
    keyProvider === 'env'
      ? {
          v1: required('CONNECT_MASTER_KEY'),
          ...(env.CONNECT_MASTER_KEYS
            ? (JSON.parse(env.CONNECT_MASTER_KEYS) as Record<string, string>)
            : {}),
        }
      : {};
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://connect:connect@localhost:5432/connect',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    keyProvider,
    masterKeys,
    masterKeyVersion: env.CONNECT_MASTER_KEY_VERSION ?? 'v1',
    kmsKeyId: keyProvider === 'env' ? undefined : required('CONNECT_KMS_KEY_ID'),
    issuer: env.CONNECT_ISSUER ?? 'http://localhost:4000',
    port: Number(env.PORT ?? env.API_PORT ?? 4000),
    dashboardUrl: env.DASHBOARD_URL ?? 'http://localhost:3000',
    betterAuthSecret: env.BETTER_AUTH_SECRET ?? 'dev-only-insecure-secret',
    apiKeyTokenTtl: Number(env.API_KEY_TOKEN_TTL ?? 900),
  };
}
