export interface ApiConfig {
  databaseUrl: string;
  redisUrl: string;
  masterKey: string;
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
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://connect:connect@localhost:5432/connect',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    masterKey: required('CONNECT_MASTER_KEY'),
    issuer: env.CONNECT_ISSUER ?? 'http://localhost:4000',
    port: Number(env.API_PORT ?? 4000),
    dashboardUrl: env.DASHBOARD_URL ?? 'http://localhost:3000',
    betterAuthSecret: env.BETTER_AUTH_SECRET ?? 'dev-only-insecure-secret',
    apiKeyTokenTtl: Number(env.API_KEY_TOKEN_TTL ?? 900),
  };
}
