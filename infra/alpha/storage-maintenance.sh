#!/bin/sh
set -eu

access_key="$(cat /run/secrets/minio_access_key)"
secret_key="$(cat /run/secrets/minio_secret_key)"
mc alias set alpha "https://minio:9000" "$access_key" "$secret_key" >/dev/null
backup_id="${ALPHA_BACKUP_ID:?ALPHA_BACKUP_ID is required}"
case "$backup_id" in ""|[!A-Za-z0-9]*|*[!A-Za-z0-9_-]*) echo "Invalid backup id" >&2; exit 1;; esac

case "${ALPHA_STORAGE_ACTION:?ALPHA_STORAGE_ACTION is required}" in
  backup)
    mkdir -p "/backup/$backup_id/private" "/backup/$backup_id/public"
    mc mirror --overwrite "alpha/${OBJECT_STORAGE_PRIVATE_CONTAINER:?}" "/backup/$backup_id/private" >/dev/null
    mc mirror --overwrite "alpha/${OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER:?}" "/backup/$backup_id/public" >/dev/null
    mc ls --recursive --json "alpha/${OBJECT_STORAGE_PRIVATE_CONTAINER}" > "/backup/$backup_id/private-manifest.jsonl"
    mc ls --recursive --json "alpha/${OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER}" > "/backup/$backup_id/public-manifest.jsonl"
    ;;
  restore-clone)
    restore_suffix="${ALPHA_RESTORE_SUFFIX:?ALPHA_RESTORE_SUFFIX is required}"
    case "$restore_suffix" in *[!a-f0-9]*|"") echo "Invalid restore suffix" >&2; exit 1;; esac
    private_clone="${OBJECT_STORAGE_PRIVATE_CONTAINER}-restore-$restore_suffix"
    public_clone="${OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER}-restore-$restore_suffix"
    if [ "${#private_clone}" -gt 63 ] || [ "${#public_clone}" -gt 63 ]; then
      echo "Restore clone bucket name exceeds the S3 limit" >&2
      exit 1
    fi
    mc mb --ignore-existing "alpha/$private_clone" "alpha/$public_clone" >/dev/null
    mc anonymous set none "alpha/$private_clone" >/dev/null
    mc anonymous set none "alpha/$public_clone" >/dev/null
    mc mirror --overwrite "/backup/$backup_id/private" "alpha/$private_clone" >/dev/null
    mc mirror --overwrite "/backup/$backup_id/public" "alpha/$public_clone" >/dev/null
    printf 'Restored storage into isolated clone buckets %s and %s\n' "$private_clone" "$public_clone"
    ;;
  *) echo "Unsupported storage maintenance action" >&2; exit 1;;
esac

unset access_key secret_key
