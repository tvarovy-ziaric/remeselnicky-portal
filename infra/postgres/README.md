# PostgreSQL/PostGIS foundation

The repository uses PostgreSQL 17 with PostGIS 3.5 from the first database
revision. The extension is enabled by the version-controlled
`packages/db/migrations/0000_enable_postgis.sql`; no domain tables belong to
this foundation revision.

## Local development

Set the three required local-only values in your shell, then start the service:

```powershell
$env:PORTAL_POSTGRES_PASSWORD = "choose-a-local-owner-password"
$env:PORTAL_APP_DB_PASSWORD = "choose-a-different-local-app-password"
$env:DATABASE_URL = "postgresql://portal_app:$env:PORTAL_APP_DB_PASSWORD@localhost:5432/portal"
docker compose up -d postgres
```

`PORTAL_POSTGRES_PASSWORD` belongs to the local migration owner;
`PORTAL_APP_DB_PASSWORD` belongs to the restricted runtime login. Neither value
is checked into source control. The initialization scripts enable PostGIS and
create the non-owner application login only when the data volume is first
created. After changing bootstrap variables, recreate only the explicitly named
local `portal-postgres-data` volume if a disposable reset is intended.

Verify readiness without printing a connection URL:

```powershell
docker compose ps postgres
docker compose exec postgres psql --username portal_owner --dbname portal --command "SELECT PostGIS_Version();"
```

## Staging contract

`staging.contract.example.yaml` is a credential-free provisioning contract, not
a deployable secret file. Staging uses a dedicated private PostgreSQL instance,
TLS verification, and distinct migration-owner and runtime-application
principals. The deployment secret store injects `DATABASE_URL` into the API; it
must never be placed in Compose files, CI output, images, or repository files.

Provision the PostGIS binaries through the PostgreSQL provider, then run the
foundation SQL as the migration owner. The API runtime principal requires only
`CONNECT`, schema `USAGE`, and explicit privileges on future objects. It must
not own the database, create extensions, create databases, or create roles.

Development, staging, and production must use separate databases, principals,
credentials, and secret references. Production provisioning remains outside
this local/staging foundation and is subject to the later release gate.
