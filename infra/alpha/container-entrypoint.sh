#!/bin/sh
set -eu

read_secret() {
  variable_name="$1"
  file_variable_name="${variable_name}_FILE"
  eval "file_path=\${$file_variable_name:-}"
  if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
    echo "$file_variable_name must name a mounted secret file" >&2
    exit 1
  fi
  value="$(cat "$file_path")"
  if [ -z "$value" ] || printf '%s' "$value" | grep -q '[[:space:]]'; then
    echo "$file_variable_name contains invalid secret material" >&2
    exit 1
  fi
  export "$variable_name=$value"
}

case "${ALPHA_DATABASE_ROLE:-runtime}" in
  owner)
    read_secret PORTAL_DB_OWNER_PASSWORD
    database_user="${PORTAL_POSTGRES_USER:?PORTAL_POSTGRES_USER is required}"
    database_password="$PORTAL_DB_OWNER_PASSWORD"
    unset PORTAL_DB_OWNER_PASSWORD
    ;;
  runtime)
    read_secret PORTAL_APP_DB_PASSWORD
    database_user="${PORTAL_APP_DB_USER:?PORTAL_APP_DB_USER is required}"
    database_password="$PORTAL_APP_DB_PASSWORD"
    unset PORTAL_APP_DB_PASSWORD
    ;;
  *)
    echo "ALPHA_DATABASE_ROLE must be owner or runtime" >&2
    exit 1
    ;;
esac

case "$database_user$database_password" in
  *[!A-Za-z0-9_.~-]*)
    echo "Alpha database credentials contain URL-unsafe characters" >&2
    exit 1
    ;;
esac

export DATABASE_URL="postgresql://${database_user}:${database_password}@postgres:5432/${PORTAL_POSTGRES_DB:?PORTAL_POSTGRES_DB is required}?sslmode=verify-full"
unset database_password

if [ -n "${SESSION_SECRET_FILE:-}" ]; then
  read_secret SESSION_SECRET
fi
if [ -n "${OBJECT_STORAGE_ACCESS_KEY_ID_FILE:-}" ]; then
  read_secret OBJECT_STORAGE_ACCESS_KEY_ID
fi
if [ -n "${OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE:-}" ]; then
  read_secret OBJECT_STORAGE_SECRET_ACCESS_KEY
fi

exec "$@"
