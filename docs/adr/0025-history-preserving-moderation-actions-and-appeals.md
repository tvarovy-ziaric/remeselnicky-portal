# ADR 0025: History-preserving moderation actions and appeals

- Status: Accepted for the Web Alpha implementation
- Date: 2026-09-25
- Tickets: R4-023
- Locked references: D21, D23, D24, D25, D26, D27, D30

## Context

A report is only a claim. The alpha needs a manual policy workflow that can
protect users and marketplace surfaces without turning report volume into a
verdict, rewriting a message or review, erasing verified Job history, or
conflating ordinary commercial disagreement with moderation. Significant
actions must also remain explainable, reversible and appealable.

The live admin transport remains behind the provider-neutral recent-MFA gate
from ADR 0005. Ordinary affected users still need a private action and appeal
surface, including while an account is suspended.

## Decision

Keep five append-only concepts separate: the original report, report-state
events, a named admin command/decision, its enforcement action, and an appeal
with a later correction. A target may have reports from independent reporters;
one reporter is rate- and duplicate-bounded per target. Report counts never
drive a transition. Admin commands use exact expected state, deterministic
idempotency, a stable policy category/reason/version, a recent MFA-backed
`admin.reviews.moderate` session and a matching D23 audit event in the same
transaction. Reporters cannot decide their own report and appellants cannot
decide their own appeal.

The enforcement model supports warning, content hide, review-evidence
exclusion, granular messaging/publishing/quoting/review restrictions, temporary
restriction and indefinite account suspension. A database-derived target owner
or conversation participant must match the affected user. Temporary actions
require a future expiry. Appeal reduction must materially narrow the original
scope or duration; uphold and reverse remain distinct. Filing an appeal never
lifts the action by itself.

Content is hidden through current projections, never source mutation. A hidden
review retains its rating dimensions while an explicit evidence exclusion
removes the review from reputation. Hidden messages render a neutral tombstone
but remain immutable internally. Profile hiding composes with, rather than
overwrites, the owner's last `PUBLIC/HIDDEN` preference and existing approval
history, so reversal restores only what would otherwise still be public.
Portfolio projects/assets and private media delivery fail closed on an active
hide. Job, Quote, participation, dispute and review source histories are never
deleted or rewritten.

Affected users see only their action type, scope, active state, safe general
category/reason, expiry and appeal state. Private notes, antifraud signals and
internal policy detail are not projected or copied into notification payloads.
Admins must state and audit a purpose before opening report or appeal detail.
Risk flags remain private, provenance-bearing signals rather than verdicts or
public reputation.

The user and admin HTTP commands are CSRF-protected, exact-shape validated and
rate-limited. Admin routes are dependency-injected but remain unregistered in
the real startup until the authorized MFA provider adapter and enrolled admin
exist. R4-025 will apply the granular restriction projection across the final
cross-entity permission matrix; this ADR does not weaken any existing
server-side authorization in the interim.

## Consequences

- Reversal removes the current enforcement effect while preserving the report,
  decision, action, appeal, correction and audit history.
- A negative review is not hidden merely because it is negative, and a Job
  dispute does not automatically become a policy violation.
- Public and private delivery projections can fail closed immediately without
  destructive deletion or later reconstruction.
- Notification outbox events contain action/appeal identity and a safe general
  category or decision, never user content, private notes or sensitive evidence.
- Clean PostGIS integration must prove hide/restore, immutable source content,
  reputation separation, profile visibility composition and audit coupling.
- Real moderator enrollment and first live enforcement remain human gates, not
  implied authorization from the local implementation.
