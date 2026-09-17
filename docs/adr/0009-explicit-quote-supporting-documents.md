# ADR 0009 — Explicit supporting documents in accepted Quote revisions

Status: Accepted (R4-003 foundation, 2026-09-16)

## Context

D14 permits supporting Quote documents and D16 requires the Job to preserve
everything explicitly included in the accepted Quote revision. A raw upload or
conversation attachment is not proof that the provider included it in the
commercial offer. External-PDF Quotes already have a separate authoritative
primary PDF, while structured Quotes had no document-binding path.

## Decision

The provider uploads a private, scanned `QUOTE_DOCUMENT` PDF for the exact
`QUOTE_REVISION` and then explicitly binds its READY asset to a DRAFT revision.
The binding is append-only and records the actor, server timestamp and content
hash. A mistaken inclusion is excluded by a separate append-only, DRAFT-only
removal event; the original inclusion is never erased. Submitting the Quote
closes both operations. A revoked or unclean included document blocks Job
creation rather than silently disappearing. Job creation atomically captures
the active included-document IDs, hashes, metadata and provenance in an
immutable snapshot table. The accepted primary external PDF remains a separate
authoritative attachment; chat media never implicitly joins the agreement.
The database bounds one revision to ten active supporting PDFs; a DRAFT removal
frees a slot without deleting evidence.

The private upload, bind, list and removal endpoints derive the actor from the
session and require CSRF for writes. Private-media delivery rechecks current
Quote ownership and draft/submitted visibility; an excluded document is not
granted through the supporting-document binding. The support flow currently
accepts validated PDFs, including PDF breakdowns and supporting documents;
other document formats and visual authoring controls remain separate work.

## Verification and remaining work

Clean migrations `0000`–`0064` and the full local PostGIS integration suite
passed. The tests cover both authoring modes, owner/draft/READY checks,
processing and revoked files, immutable inclusion/removal history, private
delivery before and after submission, atomic accepted-Job capture and failure
when an included canonical object is revoked. API contract/security tests cover
session actor, exact input, no-store responses and safe status mapping.
The same migrations are now applied to the synthetic Quick Tunnel alpha, with
the API, worker and web healthy. Public E2E uploaded, bound and submitted a
supporting PDF, checked customer delivery and recap rendering, denied
competitor/foreign-customer access, and passed again without duplicating the
fixture. The complete 27-case public browser suite passed (23 pass, 4
intentional media-engine skips) after this submitted revision.

The final customer recap fetches and displays the exact active list, failing
closed on malformed or unavailable documents. R4-003 subsequently completed
with guarded acceptance/contact unlock and public synthetic E2E. Provider-facing
document authoring controls are not yet exposed in the Web UI.
