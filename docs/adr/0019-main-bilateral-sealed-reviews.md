# ADR 0019: Main bilateral sealed Job reviews

- Status: Accepted for R4-017 implementation
- Date: 2026-09-17
- Tickets: R4-017, with R4-018–R4-020 extensions

## Context

D05/D21 require exactly one ordinary customer-to-primary-provider review and one
primary-provider-to-customer review opportunity per completed platform Job.
Reviews have a 14-calendar-day submission window, remain blind until both
parties submit or the window expires, and allow author edits for at most 60
minutes while still sealed. A company provider is reviewed as the company;
ownership alone does not create individual reputation. Customer reputation is
not a public searchable profile.

The existing `completed_job_evidence_provenance` view distinguishes normal
customer acceptance from audited administrative completion. Initially only a
normal customer acceptance opens ordinary review rights; a mere
`COMPLETION_REQUESTED`, cancelled Job or administrative force-completion does
not. D21 leaves any review eligibility after administrative completion to the
separate D22/D23 exception policy, so this ticket must not grant it implicitly.

## Decision

Derive the two directional opportunities from completed-Job provenance and
the historical customer/primary-provider profile identities. The deadline is
the same Bratislava-local wall-clock time 14 calendar days after `completed_at`;
it never extends because the other party submitted near the deadline. Store
each submission/edit as an append-only, command-identified review revision.
The first revision is submission; a later revision is an edit. The Job row is
locked before writing so competing submissions/edits see one serialization
order. The author must own the correct historical profile, hold an active
verified account and not control both sides of the review. Database and API
checks both deny by default.

Dimension keys are exact per direction. Each dimension accepts an integer 1–5
or `null` for N/A. Customer-to-provider includes the seven D21 dimensions;
provider-to-customer includes the six D21 dimensions. At least one scored
dimension is required. Optional plain-language comments are bounded and
stored privately; review text is never placed into outbox/audit payloads.
The accepted Job profession is the initial verified context for the primary
provider review. Additional professions may be attached later only through
an evidence-backed extension, not from self-declared profile claims.

Unlock is derived rather than a mutable status: both first submissions exist,
or the fixed deadline has passed. Once unlocked, neither author may edit, even
if 60 minutes have not elapsed. A submission before the deadline remains
sealed after the opposite party misses the deadline and becomes visible only
when the deadline passes. The non-submitter then loses the ordinary right to
submit. Exceptional eligibility/reopening and post-lock changes require the
separately audited admin/moderation workflows of R4-020/R4-022; they do not
mutate the historical review revisions.

Public provider reputation reads only unlocked customer-to-provider reviews,
with evidence count and profession context. A review score is the equal mean of
its answered dimensions; the profile/profession score is then the equal mean of
review scores, so reviews with more applicable dimensions do not silently gain
more weight. Public reads expose only an opaque review-revision identifier,
profession, seven dimensions, derived score, privacy-filtered comment and
Bratislava-local month. They never expose the Job, customer/author identity or
an exact timestamp. Provider-to-customer reviews remain available only in an
authorized invitation context.

Evidence counts are always shown. Search cards may display the unlocked score
and count, but `review_sample_sufficient` remains false and score-based ranking
does not activate until a governed confidence policy exists. This preserves
D05/D10 small-sample neutrality without inventing a numeric threshold that the
locked product specification explicitly defers.

## Consequences

Review opportunity existence is immediately consistent with committed Job
completion without another mutable invitation row. Reminders can derive
unsubmitted opportunities and use the existing privacy-minimal outbox. Review
history and admin-completion provenance remain inspectable without leaking
sealed content. This ADR does not define participant/workgroup reviews,
supervisor evaluations or moderation outcomes; those remain separate R4
tickets and must not be flattened into the main bilateral score.
