# Skills and specializations (R1-005)

Migration `0017_skills_specializations.sql` adds optional, owner-declared
specializations and skills without making them publication requirements or
reputation points.

## Governance boundaries

- Specializations reference the current, human-approved canonical profession
  taxonomy and must belong to the profile's active profession assignment.
- Canonical/suggested skills live in a separate versioned `skill_catalog_*`
  release. A catalog is pinned to the exact profession-taxonomy release against
  which its many-to-many profession links were reviewed.
- Catalog checksums cover both skill identities and their profession links.
  Catalog child rows are accepted only in the release installation transaction;
  a failed/partial install rolls back, and late inserts are rejected.
- Activating a catalog requires approved canonical governance, the current
  profession taxonomy, and at least one profession-linked skill. No Slovak
  production content or evidence threshold is introduced by this ticket.

## Claims and history

- A canonical skill claim pins its catalog release and skill code. A custom
  claim stores the accepted trade wording exactly in `retained_custom_text`.
- Future-public catalog labels and custom wording reject contact-channel,
  address-keyword and secret patterns. Legitimate trade notation such as
  `1/2` or `230/400 V` is retained unchanged.
- One skill claim can link to multiple active professions. A governed skill is
  accepted only when every requested link exists in the catalog's profession
  mapping.
- Later mapping of a custom skill appends a revisioned mapping event. It never
  rewrites or removes the retained original text.
- Add, mapping, and deactivation commands carry immutable fingerprints and
  required-effect constraints. Claims are deactivated rather than deleted.
  Repository commands lock the active owner/profile boundary and are safe for
  exact retries.

## Presentation boundary

Current views expose `declaration_source = CRAFTSMAN` separately from the
nullable evidence-supported timestamp. R1-005 has no owner write path for
evidence, so the owner projection returns evidence as `null`. Skills have no
`BEGINNER / ADVANCED / MASTER` field. They also expose `ranking_signal = NONE`:
optional profile richness can help later relevance explanations, but quantity
does not become reputation or ranking.
