# Alpha analytics event catalog

The executable, versioned catalog is
`packages/analytics/src/catalog.ts`. Every entry declares its semantic trigger,
source (`CLIENT_UX`, `SERVER_QUERY`, or `SERVER_DOMAIN`), schema version and
exact property allowlist. `packages/analytics/src/validation.ts` rejects unknown
events, properties, invalid IDs/enums and incompatible schema versions before
delivery.

## Stable event groups

- Discovery: `public_profile_viewed`, `search_started`, `search_executed`,
  `search_results_viewed`, `craftsman_profile_opened_from_search`,
  `craftsman_request_cta_clicked`, shortlist add/remove.
- Account/request: registration and verification completion,
  `job_request_started/submitted/cancelled/expired/reactivated`, material request
  revision.
- Demand response: invitation sent/received/viewed/engaged/declined/expired/
  withdrawn/not-selected and privacy-minimal conversation participation facts.
- Quotes: draft/submission/revision/view/comparison/PDF-open and authoritative
  rejection/withdrawal/expiry/acceptance.
- Job execution: confirmation/start, participant invite/join/leave, progress,
  issue and milestone facts.
- Commercial/completion: Change-order proposal/revision/decision/withdrawal,
  completion request/view/accept/reject and final `job_completed`.
- Trust/process: review opportunity/submission/expiry/pair completion,
  participant/workgroup reviews, supervisor evaluation, response/report,
  dispute open/close, report creation and moderation action.
- Notifications: canonical creation, delivery success/failure, in-app read and
  deep-link open. Delivery/read/click never means business acceptance.

Critical conversions are emitted only after their successful server-side
domain transaction. Client events are limited to actual views/navigation and
cannot substitute a business transition. Capture/delivery is isolated from the
domain transaction so analytics outage never rolls back product state.

## Prohibited payloads

The catalog and tests prohibit arbitrary entity serialization and properties
for chat/message/review/dispute text, exact address or coordinates, email,
phone, password/OTP/token, documents, filenames, signed URLs, evidence content
and raw search text. Governed categories use bounded machine codes; media and
activity use IDs, booleans, count buckets or bounded counts only.
