# Authentication-boundary draft survival

R3-003 preserves the D01 conversion invariant without creating anonymous
server-side job requests or putting request content into cookies.

Before authentication, the browser may retain one already-entered meaningful
section in origin-scoped IndexedDB. The stored envelope uses the same bounded
R3-002 section validator and has an explicit expiry and local revision. It is
not sent to analytics, logs, URLs, referrers, cookies, or server sessions.

The CSRF-protected arm operation stores only a random UUID marker in the
anonymous server session. Registration and login regenerate the session ID and
preserve this marker, while the old CSRF secret is deliberately not preserved.
The client must use the new authenticated session and newly issued CSRF token
for the consume operation.

Consume derives the actor exclusively from the authenticated session, lazily
ensures that actor's private CustomerProfile, validates the local section, and
uses R3-002 `CREATE_DRAFT_WITH_SECTION`. Request identity, first DRAFT revision,
and first section effect therefore commit atomically. The marker is the command
idempotency key, not a bearer credential, and is never returned to the browser.

After commit, the session retains only a completed marker so a lost response
can retry the exact operation and receive the same draft. A different payload
with that marker fails as an idempotency conflict. A new arm replaces completed
state with a fresh marker. Logout/session expiry removes server marker state.

The browser deletes its local envelope only after a confirmed server result and
only if the local revision is unchanged. A newer edit from another tab is never
deleted by an older in-flight consume. Failed arm, authentication, consume, or
storage operations leave recoverable local content in place.

This module is an infrastructure boundary, not a pre-authenticated full request
form. D01 still requires authentication before starting the JobRequest form;
R3-004 owns the first meaningful field schema and UI wiring.
