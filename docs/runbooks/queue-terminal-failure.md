# Queue terminal failure or sustained lag

Severity: critical for terminal failure; warning for sustained lag. Owner: the
named alpha incident owner.

## Meaning

A queued operation exhausted retries/reached a non-retryable terminal state, or
the oldest pending delivery exceeded the initial staging threshold. A retry is
not evidence that the underlying business action failed; inspect the domain
event/outbox state before communicating impact.

## First diagnostics

1. Confirm environment/release, queue depth, oldest age and terminal-failure
   increase.
2. Correlate the bounded error code with privacy-safe worker records using the
   event/run ID. Do not copy payloads, message bodies or recipient details.
3. Check worker replicas/crash loops and the relevant provider (email, media or
   another registered handler).
4. Determine whether the authoritative business transaction committed. Never
   replay it manually by editing database state.

## Safe mitigation and escalation

Pause the affected producer if backlog growth threatens capacity. Restore the
dependency or deploy a compatible fix, then use the queue's idempotent retry or
explicit replay command when available. Do not delete terminal records. Treat
transactional delivery as higher priority than analytics and record owner,
impact, actions and recovery in the incident timeline.
