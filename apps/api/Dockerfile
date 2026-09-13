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
COPY packages/testing/package.json packages/testing/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm --filter @portal/api... build

FROM node:24.8.0-bookworm-slim AS runtime
ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision=$RELEASE_REVISION \
      org.opencontainers.image.source="https://github.com/tvarovy-ziaric/remeselnicky-portal"
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /workspace ./
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/start.js"]

