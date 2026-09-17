#!/usr/bin/env bash
set -Eeuo pipefail

: "${PORTAL_APP_DB_USER:?PORTAL_APP_DB_USER must be set}"

if [[ -n "${PORTAL_APP_DB_PASSWORD_FILE:-}" ]]; then
  PORTAL_APP_DB_PASSWORD="$(<"$PORTAL_APP_DB_PASSWORD_FILE")"
fi
: "${PORTAL_APP_DB_PASSWORD:?PORTAL_APP_DB_PASSWORD or PORTAL_APP_DB_PASSWORD_FILE must be set}"
: "${PORTAL_DATABASE_ENVIRONMENT:=development}"

case "$PORTAL_DATABASE_ENVIRONMENT" in
  development|staging|test) ;;
  *)
    echo "PORTAL_DATABASE_ENVIRONMENT must be development, staging or test" >&2
    exit 1
    ;;
esac

if [[ "$PORTAL_APP_DB_USER" == "$POSTGRES_USER" ]]; then
  echo "PORTAL_APP_DB_USER must differ from the migration-owner POSTGRES_USER" >&2
  exit 1
fi

psql --set ON_ERROR_STOP=on \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set app_database="$POSTGRES_DB" \
  --set database_environment="$PORTAL_DATABASE_ENVIRONMENT" \
  --set app_user="$PORTAL_APP_DB_USER" \
  --set app_password="$PORTAL_APP_DB_PASSWORD" <<-'SQL'
SELECT format(
  'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'app_user',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'app_user',
  :'app_password'
) \gexec

GRANT CONNECT ON DATABASE :"app_database" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";

SELECT format(
  'ALTER DATABASE %I SET portal.environment = %L',
  :'app_database',
  :'database_environment'
) \gexec
SQL
