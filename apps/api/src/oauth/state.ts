import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface OAuthState {
  connectorId: string;
  orgId: string;
  codeVerifier?: string;
  /** Dashboard URL to bounce back to after the callback. */
  redirectTo?: string;
  /** When set, the resulting installation is a user-subject grant for this user. */
  subjectUserId?: string;
  initiatedByUserId?: string;
}

const TTL_SECONDS = 600;

export async function createState(redis: Redis, data: OAuthState): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  await redis.set(`oauthstate:${state}`, JSON.stringify(data), 'EX', TTL_SECONDS);
  return state;
}

/** Single-use: GETDEL prevents replay of a leaked state value. */
export async function consumeState(redis: Redis, state: string): Promise<OAuthState | null> {
  const raw = await redis.getdel(`oauthstate:${state}`);
  return raw ? (JSON.parse(raw) as OAuthState) : null;
}
