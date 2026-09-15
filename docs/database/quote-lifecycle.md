# Quote expiry, withdrawal and stale context (R3-019)

Migration `0051_quote_lifecycle.sql` adds append-only lifecycle commands and exact state events for current `SUBMITTED` Quote revisions.

- `WITHDRAW` is an ACTIVE primary-provider command and requires the invitation/conversation to remain `ENGAGED`/writable. It uses the canonical actor → invitation → conversation → Quote → revision-head lock order and a state-revision compare-and-swap.
- `EXPIRE` is not an HTTP command. The worker claims at most 100 due submitted Quotes in deadline/UUID order with `FOR UPDATE SKIP LOCKED`; command identity is generated server-side and the trigger overwrites system provenance, deadline snapshot, target state, result revision and timestamp.
- There is no invented validity duration. Only an explicit, mode-specific `valid_until` can become due, and both the due check and comparison boundary use PostgreSQL `clock_timestamp()`.
- An expired or withdrawn revision remains immutable history. Reconfirmation creates a new `DRAFT`, pinned to the current active JobRequest content/visible version, from the exact current submitted or latest terminal source. The input names source revision, state and state revision; old terminal revisions cannot be revived.
- Material staleness compares `request_visible_version`, not every content revision. A non-material edit keeps the Quote current; a material edit keeps the submitted Quote visible in comparison with a warning but makes the lifecycle readiness fact false.

`current_quote_acceptance_context.lifecycle_acceptance_eligible` is deliberately narrow. It says only that the Quote is still submitted, not materially stale, not past its deadline, and its exact authoring content remains available. It is **not** complete D16 acceptance authority: R4 must still recheck customer/provider eligibility, current credential requirements, exact request/location, PDF/canonical-object availability and all transactional Job-creation invariants.

Comparison excludes a deadline-passed Quote immediately, even before the maintenance worker materializes `EXPIRED`. Stale submitted Quotes remain visible so the customer can understand why provider reconfirmation is required. Neither state creates a Job or implies acceptance.

Private API routes expose only owned lifecycle context, provider withdrawal and provider reconfirmation. They derive the actor from the authenticated session, require CSRF for writes, return generic absence/conflict responses, use `no-store`, and intentionally expose no expiry endpoint.
