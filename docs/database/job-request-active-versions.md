# Active JobRequest versions

R3-005 keeps active-request editing separate from the existing DRAFT/ACTIVE
lifecycle revision. Activation creates content revision `1` and visible version
`1` from the exact accepted draft snapshot. Every later content change appends
an immutable command, content revision, and changed section; historical reads
reconstruct the exact snapshot at a requested content revision.

The server compares canonical normalized content and derives change categories.
An isolated title correction is minor: it advances the internal content revision
but preserves the visible version. Scope, profession, location, schedule, budget,
media, material-responsibility, and other-requirement changes are material and
advance the visible version. Clients cannot submit either classification or the
resulting version number.

Commands are owner-only, require an ACTIVE account and ACTIVE request, use an
expected content revision, and are serialized by request row locks. Exact command
retries return the original effect; reused command IDs with different intent fail.
Equivalent content is recorded as durable `UNCHANGED` without a new revision.

The database independently validates section shape, governed references, private
READY media provenance, classification, contiguous revisions, and exact command
effects. Baseline and edit snapshots are transaction-sealed and all history tables
reject updates and deletes.

The ledger persists the stable material-change categories needed by R3-009.
Notification/outbox delivery is intentionally not claimed here; R3-009 must append
its event atomically from these authoritative version facts while preserving old
quote/request provenance under D04/D11/D12.
