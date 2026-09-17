#!/bin/sh
set -eu

export MINIO_ROOT_USER="$(cat /run/secrets/minio_access_key)"
export MINIO_ROOT_PASSWORD="$(cat /run/secrets/minio_secret_key)"
if [ -z "$MINIO_ROOT_USER" ] || [ "${#MINIO_ROOT_PASSWORD}" -lt 16 ]; then
  echo "MinIO alpha credentials are invalid" >&2
  exit 1
fi

exec minio server /data --address :9000 --console-address :9001 --certs-dir /run/alpha-tls/minio
