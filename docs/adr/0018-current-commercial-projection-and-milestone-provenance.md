# ADR 0018 — Current commercial projection and milestone provenance

Status: accepted (R4-013, 2026-09-17)

## Context

D19 keeps the accepted Quote/Job snapshot immutable and derives the current agreement only from exact approved Change-order revisions. D18 milestones are optional operational plans, not commercial approval or payment records. A revision can identify existing affected milestones, but it does not contain a complete structured milestone-plan patch that could safely be applied at approval.

## Decision

- The private Job dashboard derives a read-only, source-traceable projection from the accepted Quote and chronologically approved revisions in one database read transaction. Proposed, rejected, withdrawn and superseded revisions never contribute. Only a compatible fixed EUR base and fixed deltas with matching VAT yield an exact total; estimates, ranges, PDFs and invalid arithmetic retain an explicit uncertainty state.
- Approval records the commercial decision; it does not silently edit milestone plans. A subsequent explicit provider CREATE/EDIT command may pin the exact same-Job approved revision to an append-only milestone event. Existing-milestone edits require that the revision explicitly names that milestone among its affected IDs. A new milestone cannot preexist in such a list, so its approved-revision link is provenance of the provider's plan, not machine proof of a specific commercial amount or scope mapping.
- The database validates actor, Job, revision approval and affected-milestone membership for new links; read DTOs and history preserve the exact revision ID. Noncommercial milestone actions carry the prior link forward. The original Quote stage source is never rewritten. A milestone cannot create a price, approval, invoice or payment obligation.
- The UI offers only approved revisions and states this boundary. Exact commercial terms remain in the immutable approved revision and, for an external-PDF addendum, its private authoritative PDF.

## Verification boundary

Require a clean migration/replay, direct-SQL wrong-Job/unapproved/actor denials, immutable source history, old-command idempotent replay, API/Web parser negatives and a synthetic public customer/provider/competitor path. A real-user rollout still requires the D30 gate.
