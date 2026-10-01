# Managed profession/service catalog v1 — implementation plan

Status: `DONE` on local synthetic Quick Alpha (approved product decision,
2026-10-01; genuine admin browser UAT remains `NOT_EVALUATED` behind real MFA)

## Audited baseline

- The existing immutable `profession_taxonomy_releases` mechanism is the
  canonical governance boundary. It already owns professions,
  specializations and aliases; the new service vocabulary will extend this
  release rather than create a parallel taxonomy.
- D06 keeps `Profession`, `Specialization` and `Skill` distinct. `Service` is
  added as a fourth, explicit discovery/offer concept: a concrete activity,
  linked to one or more professions. It does not replace a skill or a
  profession.
- JobRequest and public search already share the public taxonomy autocomplete
  endpoint. Craftsman profession authoring uses the same client but filters to
  professions. The contract will be extended once and reused by all three.
- Craftsman profession history is pinned to its original immutable release.
  Public member counts therefore aggregate active, effectively-public profile
  relations by stable canonical code across releases; they never expose draft,
  hidden, rejected, moderated or suspended profiles.
- The existing admin boundary provides server capability checks, recent MFA,
  CSRF, rate limits, immutable audit and fail-closed route registration. The
  taxonomy admin module will use that boundary without a synthetic bypass.
- The existing notification/outbox pipeline is the only delivery mechanism for
  requester decisions. Suggestion descriptions stay in the authorized detail
  and are not copied into general notification payloads.

## Delivery slices

1. **Governed catalog and search**
   - extend the immutable release with services, profession/service links,
     descriptions, normalized aliases and appropriate indexes;
   - install a deterministic Slovak v1 snapshot with stable codes, about forty
     professions, about 150 services and a substantially richer alias layer;
   - implement server-side accent/case/space/separator normalization,
     conservative typo matching, exact requested precedence, stable ordering,
     hard top-10 output and privacy-safe unique public member counts.
2. **Shared customer/craftsman contract**
   - expose only canonical code, kind, label, profession links and member count;
   - use one accessible combobox in JobRequest, public search and craftsman
     authoring, with textual type badges, counts, legend and keyboard/touch
     behavior;
   - add append-only craftsman-to-service assignments and owner-only commands.
3. **Suggestion and admin workflow**
   - persist immutable craftsman-owned suggestions and idempotent submission;
   - provide pending/detail/similar-item review and explicit approve-as-new,
     map-to-existing or reject commands;
   - make canonical/alias edits create and activate a new immutable release,
     surface normalized alias collisions and preserve the original proposal;
   - require admin capability, recent MFA, CSRF, audit and safe rate limits.
4. **Notifications, UI and proof**
   - send an actionable admin notice on submission and a requester notification
     for every final outcome through the existing outbox/catalog;
   - complete unit, route, repository, authorization, migration replay and UI
     tests, then run the customer and craftsman Quick Tunnel browser scenarios;
   - keep genuine admin browser UAT `NOT_EVALUATED` until the existing real MFA
     provider/enrollment gate is available.

## Completion boundary

This work is not `DONE` until the catalog data, shared autocomplete, secure
counts, service assignments, suggestion/admin/alias workflow, notifications,
clean migration replay, relevant test suites, customer/craftsman browser
evidence and checkpoint/UAT documentation all pass. No production rollout or
real-user go/no-go is implied.
