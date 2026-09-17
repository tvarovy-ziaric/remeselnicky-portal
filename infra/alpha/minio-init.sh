#!/bin/sh
set -eu

access_key="$(cat /run/secrets/minio_access_key)"
secret_key="$(cat /run/secrets/minio_secret_key)"
mc alias set alpha "https://minio:9000" "$access_key" "$secret_key" >/dev/null
mc mb --ignore-existing "alpha/${OBJECT_STORAGE_PRIVATE_CONTAINER:?}" >/dev/null
mc mb --ignore-existing "alpha/${OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER:?}" >/dev/null
mc anonymous set none "alpha/${OBJECT_STORAGE_PRIVATE_CONTAINER}" >/dev/null
mc anonymous set none "alpha/${OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER}" >/dev/null
mc admin info alpha >/dev/null
unset access_key secret_key
