# syntax=docker/dockerfile:1
FROM node:24.8.0-bookworm-slim AS toolchain

ENV CI=true \
    DO_NOT_TRACK=1 \
    PNPM_HOME=/pnpm \
    TURBO_TELEMETRY_DISABLED=1
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /workspace

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/testing/package.json packages/testing/package.json
COPY packages/admin-auth/package.json packages/admin-auth/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/authorization/package.json packages/authorization/package.json
COPY packages/commands/package.json packages/commands/package.json
COPY packages/media/package.json packages/media/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/outbox/package.json packages/outbox/package.json
COPY packages/privacy/package.json packages/privacy/package.json
COPY packages/projections/package.json packages/projections/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/taxonomy/package.json packages/taxonomy/package.json
COPY packages/search/package.json packages/search/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm --filter @portal/worker... build

FROM node:24.8.0-bookworm-slim AS runtime
ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision=$RELEASE_REVISION \
      org.opencontainers.image.source="https://github.com/tvarovy-ziaric/remeselnicky-portal"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace ./
USER node
CMD ["node", "apps/worker/dist/start.js"]
