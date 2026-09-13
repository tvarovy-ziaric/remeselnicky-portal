# syntax=docker/dockerfile:1
FROM node:24.8.0-bookworm-slim AS toolchain

ENV CI=true \
    DO_NOT_TRACK=1 \
    NEXT_TELEMETRY_DISABLED=1 \
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
ARG DEPLOYMENT_ENV=production
ARG RELEASE_REVISION=development
ENV NEXT_PUBLIC_APP_ENV=$DEPLOYMENT_ENV \
    NEXT_PUBLIC_RELEASE_REVISION=$RELEASE_REVISION
RUN pnpm --filter @portal/web... build

FROM node:24.8.0-bookworm-slim AS runtime
ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision=$RELEASE_REVISION \
      org.opencontainers.image.source="https://github.com/tvarovy-ziaric/remeselnicky-portal"
ENV HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace ./
USER node
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["./node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
