# API or database unavailable

Severity: critical. Owner: the named alpha incident owner.

## Meaning

The API scrape target is unavailable, or repeated readiness probes cannot reach
PostgreSQL. The signal contains only service/environment/release context.

## First diagnostics

1. Confirm environment, release marker, firing duration and whether web/API
   uptime checks agree.
2. Check API replica availability and recent deploy/migration status.
3. Check PostgreSQL provider availability, connection saturation, storage and
   network policy using protected operational tooling.
4. Correlate privacy-safe `startup` and `http_request` error records; never paste
   connection strings or user payloads into the incident timeline.

## Safe mitigation and escalation

Pause new deploys. Roll back only to a migration-compatible release; otherwise
forward-fix. Do not bypass readiness, TLS, authorization or database constraints.
Escalate to the database/infrastructure owner when the provider is unavailable.
Record detection, owner, user impact, actions and recovery time. If personal
data may be implicated, follow the D27 incident process.
