# Craftsman search read model (R2-001)

Migration `0029_craftsman_search_read_model.sql` defines discovery as live
`SECURITY INVOKER` views over the authoritative R1 aggregates. It deliberately
does not create a mutable search table, materialized view, refresh worker, or
cache. A publication hide, moderation restriction, readiness loss, or owner
suspension is therefore reflected by the next SQL snapshot without refresh
lag. The repository reads one page and its child facts in a repeatable-read,
read-only transaction so a page cannot mix revisions.

## Eligibility and privacy boundary

`current_searchable_craftsman_profiles` has at most one row per profile. It
requires all of these current facts:

- `effectively_public = true` and no missing D08 requirement;
- review `APPROVED`, owner preference `PUBLIC`, moderation `ALLOWED`;
- an `ACTIVE` owner account;
- an active governed base municipality, district, and region.

The base view exposes public identity, municipality code/name and declared
service radii/extra municipality codes. It contains no owner user id, contact,
address, exact coordinate, registration number, verification reference,
storage data, or customer data. R2-003 may join its candidate profile id to
private location catalogs inside a server-only query, but coordinates must
never leave that boundary.

Names are searched through a GIN-indexed `simple` text-search document. Both
the indexed document and query use the same immutable lowercase/Slovak
diacritic translation; the implementation needs no `unaccent` extension.
Identity query text is validated, parameterized, never returned, and must not
be logged.

## Search facts and neutral hooks

Child views repeat the base eligibility gate by joining the base view:

- profession declared level and evidence-supported level are separate;
- specialization and skill declaration/evidence markers are separate;
- approved, nonexpired credentials expose only type/profession/expiry;
- experience remains explicitly `SELF_DECLARED`;
- active indicative EUR prices are contextual display/filter data, not a
  strong rank signal;
- availability exposes only the presence of an explicit declaration. Exact
  periods remain private and do not promise booking, capacity, or acceptance;
- portfolio contributes only evidence/provenance relevance codes and one
  representative media asset already admitted by the exact R1 public media
  intersection. There is no text dump, media storage field, or photo count;
- rating/review/work hooks are neutral (`null`/zero and insufficient sample)
  until authoritative downstream data exists.

The repository copies these columns into a frozen allowlisted DTO. Corrupt or
unsafe rows fail closed. UUID cursor pagination is deterministic by profile id;
filtering a corrupt row still advances the opaque cursor and cannot loop.

## Ranking boundary

R2-001 supplies candidates and facts, not a secret all-purpose score. Later
ranking must preserve the locked D10 order: profession relevance, geographic
relevance, qualification, availability, evidence/trust, then secondary
signals. Evidence may outweigh a declaration, but proficiency alone must not
rank a profile. Skill quantity, prices, image presence, completeness, founder
status, paid status, and missing cold-start history provide no generic organic
boost or penalty. Sponsored placement, if ever added, is separate and visibly
labeled. Exact weights remain server-private while the public principles and
human-readable match reasons remain explainable.
