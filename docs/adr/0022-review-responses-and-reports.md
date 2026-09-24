# ADR 0022: Public review responses and report hand-off

- Status: Accepted for R4-020 implementation
- Date: 2026-09-24
- Tickets: R4-020, with R4-023 action and appeal extensions

## Context

D21 permits the rated party one public response to a published public review.
The response must not create a discussion thread, alter the original rating or
silently replace history. Public reviews, responses and private supervisor
evaluations also need a report/challenge path. D24 requires a report to remain
a claim rather than a verdict: creating one must not automatically hide
content, exclude evidence or sanction an account.

The alpha does not yet have an authorized live moderator enrollment because
the production MFA provider adapter remains a human gate. The persistence and
ordinary-user transport can still be completed without weakening that gate.

## Decision

A response binds to the final unlocked customer-to-provider main-review
revision. Only the owner of the reviewed craftsman profile may create it. One
logical response exists per review. Its first command creates the stable
response identity and first immutable revision atomically; later revisions are
append-only and allowed only during a 60-minute edit window. The latest
revision is public with the review. There is no reply-to-response operation and
no change to the original ratings, score, author or Job provenance.

Reports use a separate moderation record with reporter, stable target type and
identifier, governed reason, optional bounded explanation and timestamp. R4-020
initially admits unlocked public main reviews, their responses and a supervisor
evaluation visible to its evaluated participant. An active verified account is
required. One reporter may create at most one logical report for the same
target; independent reporters remain independent records.

Every report receives an append-only initial `OPEN` state event. Report and
state history reject update/delete. Creating a report has no effect on public
visibility, review scores, supervisor evidence, account state or Job history.
It emits no raw content into outbox/audit payloads. Admin transitions,
visibility/evidence actions, notification policy and appeals are added through
the capability- and MFA-gated R4-023/D23–D26 workflow rather than an ordinary
user route.

## Consequences

The rated party can add concise context without starting an argument or
rewriting the reviewer. Report intake is useful immediately and already has a
history-preserving state model, while the absence of an authorized live MFA
adapter cannot be bypassed by a provisional admin endpoint. R4-023 can extend
the target enum and append moderated state/action history without migrating or
mutating original reports.
