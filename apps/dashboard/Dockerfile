FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/dashboard ./apps/dashboard/
COPY packages/shared ./packages/shared/
ARG CONNECT_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_CONNECT_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_USE_API_PROXY=false
ENV CONNECT_API_URL=$CONNECT_API_URL
ENV NEXT_PUBLIC_CONNECT_API_URL=$NEXT_PUBLIC_CONNECT_API_URL
ENV NEXT_PUBLIC_USE_API_PROXY=$NEXT_PUBLIC_USE_API_PROXY
RUN pnpm --filter @connect/dashboard build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY --from=build /app/apps/dashboard/.next ./apps/dashboard/.next
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/dashboard/next.config.ts ./apps/dashboard/
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared/
EXPOSE 3000
CMD ["pnpm", "--filter", "@connect/dashboard", "start"]
