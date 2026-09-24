# R4 final D26 permission matrix

R4-025 composes the existing object- and field-level policies with D24's current
moderation restriction projection. Route visibility and possession of a UUID are
never authority. Every private read still resolves the exact relationship in its
feature repository, and every mutation still passes its feature command/state
policy before persistence.

## Cross-cutting account and restriction rules

| Actor state                | Historical safe GET                                                                            | Ordinary mutation        | Appeal                                  | Privileged command            |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------- | ----------------------------- |
| Anonymous                  | deny unless explicitly public                                                                  | deny                     | deny                                    | deny                          |
| ACTIVE, unrestricted       | feature object/field policy                                                                    | feature action policy    | own action only                         | exact capability + recent MFA |
| ACTIVE, feature-restricted | feature object/field policy                                                                    | deny only matching scope | own action only                         | independent privileged policy |
| ACTIVE, ACCOUNT-restricted | feature object/field policy                                                                    | deny                     | own action only                         | independent privileged policy |
| SUSPENDED                  | denied by the ordinary session boundary; records remain preserved for admin/open-case handling | deny                     | own moderation appeal remains available | deny                          |
| DEACTIVATED                | deny                                                                                           | deny                     | deny                                    | deny                          |

The authenticated guard reloads the user and current restriction scopes on every
request, so an already-open browser tab cannot retain a prohibited capability.
Safe GET requests for an ACTIVE restricted account remain possible, preserving
Job and business history while object/field policies continue to run. A write is
never inferred from read permission.

## Object and field boundaries retained from R1-R4

| Surface                     | Object access                                                                                       | Sensitive/public field rule                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Craftsman profile/portfolio | exact owner for private authoring; allowlisted effective-public projection for anonymous reads      | no owner contact, home/exact address, private evidence, storage or moderation internals in public DTOs |
| Customer profile/request    | exact owner; invited provider only through its concrete invitation                                  | no generic customer endpoint; exact address and contacts stay hidden before confirmed Job              |
| Conversation                | exact customer/provider on the concrete invitation/Job; competitor and unrelated IDs fail uniformly | separate thread per provider; hidden message/media and storage metadata are not serialized             |
| Quote/revision/PDF          | owning provider lineage or request-owning customer only where the revision state permits            | provider drafts and competitor price/identity remain private; private delivery reauthorizes the asset  |
| Job/contact/documentation   | customer, primary provider or explicitly authorized participant/role for the exact Job              | commercial, operational, exact-address and contact access remain separate projections                  |
| Reviews/evaluations         | exact eligible author/target/Job overlap; sealed counterparty review remains absent until unlock    | internal evidence, moderation and fraud data never enter ordinary DTOs                                 |
| Dispute                     | exact case party or named MFA-backed admin capability                                               | ordinary Job participation grants no dispute evidence/admin-note access                                |
| Admin/moderation            | named capability, recent privileged authentication and audited reason/context                       | no role-only `admin = see everything`; internal notes remain privileged                                |

## Mutation scope map

Migration `0107_final_permission_matrix.sql` adds a database defense-in-depth
guard at explicit user-command ingress tables. `ACCOUNT` always overrides every
marketplace scope.

| Restriction scope | Blocked new actions                                                                                                              | Preserved actions/data                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `MESSAGING`       | human message creation and chat attachment upload                                                                                | conversation/timeline read, archive/mute/read state and reporting                           |
| `PUBLISHING`      | profile/profession/skill/service-area/pricing/availability/credential and portfolio authoring/publication, related media uploads | stored private/public history and independent admin review/moderation                       |
| `QUOTING`         | Quote/revision authoring, submit/reject/withdraw/reconfirm, Quote PDFs/supporting documents and acceptance                       | Quote/Job history and authorized reads                                                      |
| `REVIEWS`         | bilateral/context reviews, supervisor evaluations and provider response revisions                                                | sealed/unlocked authorized reads and reporting                                              |
| `ACCOUNT`         | all remaining ordinary request, invitation, roster, Job operation, milestone, change, completion, dispute and report commands    | immutable history; appeal/privacy/authentication and dedicated privileged correction planes |

Media upload scope is derived from the server-owned purpose. Worker processing
updates are not blocked, avoiding half-processed assets after a later sanction.
Null actors remain allowed only on command tables that already reserve them for
validated system transitions such as expiry.

## Explicit exemptions

Moderation appeals, privacy-request events, authentication/recovery, notification
and security settings, and named privileged admin correction commands are not
captured by a blanket table-name rule. They retain their own authorization,
recent-MFA/audit, or ownership policies. This prevents an account sanction from
silently removing reconsideration or privacy rights and prevents ordinary user
scope logic from weakening the privileged plane.

## Automated evidence

- `apps/api/src/auth/guard.test.ts` proves feature-only denial, ACCOUNT write
  denial, safe historical reads and the bounded appeal exception.
- Conversation, Quote and review route tests prove that writes request the exact
  `MESSAGING`, `QUOTING` or `REVIEWS` scope while reads remain unscoped.
- `packages/db/test/final-permission-matrix-schema.test.ts` verifies the explicit
  table/scope map and protected exemptions.
- The clean PostGIS migration integration creates a real current feature
  restriction, verifies scope isolation and proves direct SQL command ingress is
  denied before a business effect can be written.
- Existing R1 and R3 matrix suites remain the authoritative negative evidence for
  owner/admin separation, competitor isolation, uniform unknown/foreign denial,
  public field allowlists, sealed data and private-media substitution.
