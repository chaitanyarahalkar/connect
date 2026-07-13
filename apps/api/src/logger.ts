import { pino } from 'pino';
import { redact } from '@connect/shared';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: {
    req: (req) => redact(req),
    headers: (h) => redact(h),
  },
  redact: {
    paths: ['*.authorization', '*.token', '*.secret', '*.password', 'req.headers.authorization'],
    censor: '[REDACTED]',
  },
});
