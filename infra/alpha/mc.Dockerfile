# syntax=docker/dockerfile:1
FROM golang:1.24.8-bookworm AS build

ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOBIN=/out CGO_ENABLED=0 go install "github.com/minio/mc@${MC_VERSION}"

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/mc /usr/local/bin/mc
