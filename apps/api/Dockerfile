FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/mock-provider/package.json ./apps/mock-provider/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/db/package.json ./packages/db/
COPY packages/db/drizzle ./packages/db/drizzle/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --frozen-lockfile

FROM deps AS runner
COPY apps/api ./apps/api/
COPY packages ./packages/
COPY scripts ./scripts/
ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "pnpm --filter @connect/db migrate && pnpm --filter @connect/api start"]
