import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const LOCK_TTL_S = 30;
const POLL_INTERVAL_MS = 200;
const MAX_WAIT_MS = 8_000;

/**
 * Single-flight execution per key. The winner runs `mint`; losers poll
 * `checkCache` until the winner populates it (or the winner's lock frees up,
 * in which case a loser takes over the mint). Prevents concurrent refreshes
 * from racing a rotating refresh token.
 */
export async function singleFlight<T>(
  redis: Redis,
  key: string,
  checkCache: () => Promise<T | null>,
  mint: () => Promise<T>,
): Promise<{ value: T; minted: boolean }> {
  const lockKey = `lock:${key}`;
  const owner = randomUUID();
  const deadline = Date.now() + MAX_WAIT_MS;

  while (true) {
    const acquired = await redis.set(lockKey, owner, 'EX', LOCK_TTL_S, 'NX');
    if (acquired) {
      try {
        // Someone may have minted while we waited for the lock.
        const cached = await checkCache();
        if (cached !== null) return { value: cached, minted: false };
        const value = await mint();
        return { value, minted: true };
      } finally {
        // Release only if we still own it.
        const release = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
        await redis.eval(release, 1, lockKey, owner).catch(() => {});
      }
    }

    // Lost the race: wait for the winner to fill the cache.
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const cached = await checkCache();
    if (cached !== null) return { value: cached, minted: false };
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for concurrent token mint on ${key}`);
    }
  }
}
