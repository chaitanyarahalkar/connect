import { serve } from '@hono/node-server';
import { buildMockProvider } from './app.js';

const { app } = buildMockProvider({
  tokenTtlSeconds: Number(process.env.MOCK_TOKEN_TTL ?? 3600),
  rotateRefreshTokens: process.env.MOCK_ROTATE !== '0',
});

const port = Number(process.env.MOCK_PROVIDER_PORT ?? 4100);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`mock oauth provider listening on :${info.port}`);
});
