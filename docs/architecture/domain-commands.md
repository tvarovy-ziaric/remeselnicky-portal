# Domain command transaction pattern

`@portal/commands` is the server-only application pattern for explicit named
business commands. It deliberately contains no HTTP framework, ORM, database
driver, entity states, or transition catalogue. A feature defines commands such
as a concrete approval or submission action; broad entity patching and generic
status mutation are not part of this package.

## One authoritative transaction

For a new critical command the handler performs these operations through one
injected `TransactionRunner` transaction:

1. load current state through trusted persistence code;
2. authorize the actor against that loaded object and transaction context;
3. atomically claim the actor-scoped command/idempotency identity;
4. validate exact state, revision, eligibility, and other preconditions;
5. apply the explicit mutation;
6. append returned domain events through the `DomainEventCollector`/outbox port;
7. store the successful idempotent result;
8. commit all writes together.

Any load, policy, guard, mutation, outbox, idempotency, or commit failure rejects
the command and the transaction adapter must roll back everything. No success
response or committed domain event may survive a failed transaction. The
outbox/event collector is only a port here; R0-022 owns its durable DB model and
delivery implementation.

Command envelopes contain actor, intent input, correlation ID, and an optional
idempotency key. They do not contain a trusted current state or timestamp.
Route adapters must discard pseudo-current status/revision/timestamps supplied
outside the command-specific intent. A command may accept an expected revision
as an optimistic-concurrency precondition, but the guard compares it with the
state freshly loaded inside the transaction. Server/database time owns system
timestamps.

## Fail-closed guards

`authorize` and `guard` return only `permitCommand()` or a bounded
`denyCommand(code)`. A denial, thrown policy/guard, or malformed decision fails
closed before mutation. Concrete command modules may adapt decisions from
`@portal/authorization`; this foundation does not weaken or duplicate that
package's policy enforcement.

## Idempotency adapter contract

Every `critical: true` definition supplies a trusted scope derived from the
authenticated actor/tenant and every invocation supplies a non-empty key. The
store atomically claims `(commandName, scope, key)`. Concurrent duplicates must
serialize: exactly one transaction acquires the claim, and later callers obtain
the committed original result as `REPLAYED` without repeating the mutation or
event capture. Current object loading and actor authorization still run before
replay, so an idempotency key never bypasses a newly revoked capability. The
state-transition guard is skipped because replay performs no transition.
Claims/results participate in the same transaction, so a rollback leaves the
key retryable rather than falsely completed.

The store must never return another actor's result. Idempotency controls retries
and races; it is not authorization, and handlers that perform external effects
must still use the transactionally captured event/outbox workflow.
