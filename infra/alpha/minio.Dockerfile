# syntax=docker/dockerfile:1
FROM golang:1.24.8-bookworm AS build

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOBIN=/out CGO_ENABLED=0 go install "github.com/minio/minio@${MINIO_VERSION}"

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /usr/local/bin/minio
EXPOSE 9000 9001
