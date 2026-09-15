# Job request draft autosave and recovery

R3-002 stores authenticated job-request drafts as private, append-only server
state. It does not expose a client route or define form fields; R3-004 owns the
allowlisted request-content schemas and validation before any API wiring.

## Write contract

Each `AUTOSAVE` replaces one logical section envelope containing a bounded
machine key, schema version, and JSON object. The domain layer canonicalizes
JSON keys with a locale-independent code-point order and applies conservative
limits: 32 KiB canonical JSON, depth 8, 256 total object keys, 512 total array
items, 128 items in one array, and 8 KiB per string. The database independently
enforces the structural and storage bounds.

The request revision is the global optimistic token. A changed section appends
one command, one DRAFT request revision, and one section effect atomically. An
equivalent section writes a durable `UNCHANGED` command at the current revision
without fabricating a revision or effect. Two commands from the same base
revision serialize on the request; at most one can apply and the other receives
`STALE_REVISION`. Exact command replay returns the original result, while reuse
for another intent fails closed.

`CREATE_DRAFT_WITH_SECTION` is an internal transactional seam for R3-003. It
creates the request identity, initial DRAFT revision, and first section effect
in one transaction, avoiding an empty-draft handoff window. It is not an API or
a bearer capability.

## Recovery and privacy

Recovery and recent-draft listing lock and revalidate the ACTIVE owner before
reading. Recovery returns only current section key, schema version, normalized
payload, and timestamps. Listing is capped at 50 and returns only request IDs,
revisions, timestamps, and section counts. Commands, fingerprints, raw history,
and customer identifiers are not outward fields.

At most 32 current sections are recoverable. Historical revisions are retained
and cannot be updated or deleted. Draft payloads must never be copied into logs,
analytics, outbox events, error messages, or public serializers. Clearing a
field is represented by a valid new section payload rather than deletion.

Activation remains fail-closed through the R3-001 submission-requirement
function. Autosave cannot activate a request or weaken the future R3-004 content
checks.
