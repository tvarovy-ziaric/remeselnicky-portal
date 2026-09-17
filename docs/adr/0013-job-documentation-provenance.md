# ADR 0013: Job documentation provenance and chronology

- Status: Accepted for R4-007 implementation
- Date: 2026-09-16
- Ticket: R4-007

## Context

D13/D17 require photos and PDFs from the winning conversation to remain
visible as Job-level chronological documentation. Media is private, scanned
and canonicalized before delivery. The accepted commercial snapshot must not
become a mutable attachment list, and competing conversations must never be
mixed into a Job.

## Decision

The first Job documentation read model derives from the existing
`job_conversation_media` view, intersecting the exact winning conversation,
current `READY` canonical private object and an ACTIVE primary-party viewer.
Photo chronology uses trusted processed `captured_at` when available and
upload time otherwise; both times, author and source message ID are retained.
Documents require the clean malware-scan verdict. The list is bounded and
cursor-paginated by chronology and media ID, with photo/document category
filters. The route never exposes object-storage keys or a public URL;
downloads use the existing authorized private-media endpoint.

Direct Job uploads, optional captions/tags and participant read permissions
will be added as separate provenance-preserving extensions. No attachment
may silently change the accepted request/Quote snapshot or become a public
portfolio photo without D09 customer consent.

## Verification

Clean disposable PostGIS migration/replay and integration, API/DB/Web
authorization and pagination tests, and the full workspace `pnpm check`
passed. The isolated synthetic Quick Tunnel E2E uploaded a PDF and valid PNG
to the winning conversation, waited for clean canonicalization, verified
the same Job documentation for customer and primary provider, denied a
competitor's list and private downloads, and exercised both browser
filters. A deliberately malformed PNG was rejected by the media worker;
the valid replacement passed. No real-user rollout is implied.
