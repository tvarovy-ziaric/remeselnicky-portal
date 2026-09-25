#!/bin/sh
set -eu

owner_password="$(cat /run/secrets/postgres_owner_password)"
app_password="$(cat /run/secrets/postgres_app_password)"
case "$owner_password$app_password" in
  *[!A-Za-z0-9_.~-]*)
    echo "Alpha database secrets contain unsupported characters" >&2
    exit 1
    ;;
esac

export PGPASSWORD="$owner_password"
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/run/alpha-tls/ca.crt

psql --set ON_ERROR_STOP=on \
  --host postgres \
  --username "${PORTAL_POSTGRES_USER:?}" \
  --dbname "${PORTAL_POSTGRES_DB:?}" \
  --set app_database="${PORTAL_POSTGRES_DB:?}" \
  --set app_user="${PORTAL_APP_DB_USER:?}" <<-'SQL'
GRANT CONNECT ON DATABASE :"app_database" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app_user";
REVOKE ALL ON TABLE privacy_restore_reapplication_runs FROM :"app_user";
REVOKE ALL ON TABLE privacy_restore_applied_tombstones FROM :"app_user";
REVOKE ALL ON TABLE privacy_restore_reapplication_items FROM :"app_user";
REVOKE EXECUTE ON FUNCTION assert_privacy_restore_database_owner()
  FROM :"app_user";
REVOKE EXECUTE ON FUNCTION begin_privacy_restore_reapplication(
  varchar, varchar, char, integer
) FROM :"app_user";
REVOKE EXECUTE ON FUNCTION apply_privacy_restore_tombstone(
  varchar, uuid, uuid, uuid, privacy_retention_category,
  privacy_data_disposition, uuid, char, timestamptz
) FROM :"app_user";
REVOKE EXECUTE ON FUNCTION complete_privacy_restore_reapplication(varchar)
  FROM :"app_user";
REVOKE CREATE ON SCHEMA public FROM :"app_user";
SQL

unset PGPASSWORD app_password owner_password
