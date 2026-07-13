import { ConnectError } from '@connect/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { logger } from './logger.js';

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ConnectError) {
    const retryAfter = err.details?.retryAfterSeconds;
    if (err.code === 'rate_limited' && typeof retryAfter === 'number') {
      c.header('retry-after', String(retryAfter));
    }
    return c.json(err.toBody(), err.status as ContentfulStatusCode);
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'validation_error',
          message: 'invalid request',
          details: { issues: err.issues },
        },
      },
      400,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'internal_error', message: err.message } }, err.status);
  }
  logger.error({ err }, 'unhandled error');
  return c.json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
}
