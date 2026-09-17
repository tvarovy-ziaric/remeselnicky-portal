# ADR 0017 — Revisioned Change orders outside the immutable Job baseline

Status: proposed (R4-012, 2026-09-17)

## Context

D19 requires explicit bilateral consent for material post-acceptance commercial changes. D16's accepted Job/Quote/PDF snapshot is immutable; D18 milestones and D17 progress/Issues are operational context, not commercial authorization. D25 requires privacy-minimal important notifications linked to the exact revision, and D26 requires exact-object/revision authorization, idempotency and concurrency safety.

## Decision

- A Change order is a separate Job-bound identity with append-only revisions and lifecycle events. `DRAFT` is visible only to its proposing contractual side; `PROPOSED` exposes one exact immutable revision to the counterparty. Editing or counterproposing creates a new revision and supersedes the prior proposal without carrying approval forward.
- In alpha, counterproposing atomically creates and submits a new revision; there is no persisted private counter-draft after an existing `PROPOSED` offer. The current offer remains actionable until that submission checks the exact head and supersedes it. If the earlier offer was meanwhile decided, submission fails stale. A future private counter-draft must not silently withdraw or hide an already proposed offer.
- Only the Job's active customer or primary provider may bind their side in alpha. Job participants may record an Issue suggesting a change but cannot propose or approve a commercial amendment merely by participating. Any future delegated contracting authority needs an explicit capability and tests.
- Structured scope, price/VAT, schedule, material-responsibility and warranty changes are validated independently of free-form explanation. Fixed EUR-cent deltas may produce an exact current total only on a compatible fixed-price baseline; estimates/ranges preserve their uncertainty. An external PDF is an immutable private revision attachment and remains the detailed authoritative document when used.
- `APPROVED` requires the opposite contractual side to approve the current exact `PROPOSED` revision. The command locks the Job/Change order, checks active Job state and current revision, records actor/server time and an idempotency key, and commits approval plus privacy-minimal notification/outbox evidence atomically. No unapproved proposal changes the current commercial state. Rejection and withdrawal preserve history without changing the original agreement.
- R4-013 derives the current commercial summary from the immutable base plus chronologically approved changes, retaining source IDs for every resulting field. Approved changes that affect milestones gain explicit Change-order provenance in that transaction or an equally consistent locked operation; milestone edits alone never imply commercial consent.
- No generic status/PATCH API, chat approval, backdated consent, payment ledger, second Job or separate review opportunity is introduced.

## Verification boundary

Before enabling public synthetic commands: clean migration/replay, direct-SQL immutability and actor denials, same-revision retry, stale/counterproposal/double-approval races, fixed versus estimate/range arithmetic, external-PDF private delivery, notification deep-link privacy, API CSRF/body/rate-limit checks and customer/provider/competitor browser paths must pass. Real-user rollout remains a D30 human decision.
