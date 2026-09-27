# HTTP or worker degradation

## Meaning

The API has sustained high server-error ratio or latency, or the background worker readiness heartbeat is missing. Validation, authorization and ordinary stale-command rejections are not system failures and must not be counted as 5xx incidents.

## First diagnostics

1. Confirm environment, release revision, affected bounded route and result class on the system-health dashboard.
2. Compare API target health, PostgreSQL readiness, queue depth/oldest age and worker readiness.
3. Inspect structured errors by correlation ID and release. Never copy request bodies, tokens, contact data, addresses, chat/review/dispute text or signed URLs into incident notes.
4. For worker degradation, check crash-loop state, terminal queue outcomes and the oldest pending age before retrying anything.
5. Compare the first affected timestamp with the latest deploy and migration marker.

## Safe mitigation

- Roll back a newly unhealthy release when the previous schema/application pair is compatible and the approved release procedure permits it.
- Scale or restart only the affected stateless workload after confirming no migration/build/deploy is active.
- Leave durable outbox/queue rows in place; do not purge retries, volumes or databases.
- Do not weaken authorization, malware scanning, ranking integrity or readiness checks to clear the alert.

## Escalation

Escalate a total API/worker outage or critical transactional-delivery failure immediately to the named incident owner. Record start, detection, impact, mitigations and recovery. Tune provisional alpha thresholds only from an observed staging baseline, not merely to silence recurring alerts.
