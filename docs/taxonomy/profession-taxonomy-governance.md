# Profession taxonomy governance

R1-001 establishes the canonical, server-owned `Profession → Specialization`
taxonomy model required by D06. It deliberately does not declare the final
Slovak trade catalogue or any legally regulated credential requirement.

## Model boundaries

- A profession is a broad trade; a specialization is an optional narrower
  market/work domain belonging to one profession.
- Capability criteria are short profession-specific `ADVANCED` or `MASTER`
  evidence descriptors. They are not numeric thresholds, ratings, skills,
  licences or credentials. `BEGINNER` needs no advancement criterion.
- User-entered skills remain outside this package and can never create a
  profession, specialization or mastery criterion.
- Stable codes are identity. Slovak labels and URL slugs are presentation and
  discovery values. Aliases preserve governed legacy/search mappings.
- `ACTIVE` and `DEPRECATED + replacedByCode` are explicit snapshot states. Old
  releases are retained; rename, replacement and retirement happen in a new
  version rather than by updating/deleting history.

## Release lifecycle

Every release is a full immutable snapshot with a deterministic SHA-256 digest.
The repository inserts its release row and all professions, specializations,
criteria and aliases in one transaction. PostgreSQL records that transaction ID
and rejects content appended later. Re-running the exact version is idempotent;
a same-version/different-checksum collision fails.

Releases form a strict `version - 1` supersession chain. Activations are separate
append-only events, serialized by a database advisory lock and ordered by a
server-generated identity. Client-supplied activation timestamps are replaced
server-side. Replacement cycles are rejected both before persistence and again
by PostgreSQL before activation. Current views follow only the latest successful
activation.

## Seed status and human gate

`PLACEHOLDER_ALPHA_TAXONOMY` is deterministic, synthetic and
`HUMAN_REVIEW_PENDING`. It exists only to exercise migrations, profile relations
and tests. Database activation rejects it, so it cannot become the public/current
taxonomy.

Before any real taxonomy is activated, a human with appropriate Slovak trade and
legal context must review the profession/specialization labels, critical
capabilities and any regulated boundaries. The reviewed source becomes a new
`CANONICAL + HUMAN_REVIEW_APPROVED` release with an immutable review reference.
Credential requirements, where legally necessary, remain a separate governed
Credential/Verification model and must not be smuggled into capability criteria.

Safe update procedure:

1. copy the preceding snapshot to the next contiguous version;
2. preserve stable codes, mark retired entries `DEPRECATED`, point replacements
   to another entry in the same snapshot and retain useful legacy aliases;
3. add only reviewed Slovak labels/slugs/capability descriptions;
4. run domain validation and install the release idempotently;
5. inspect the checksum and human review reference;
6. activate through the server taxonomy service with the exact current release
   as `previousReleaseId`;
7. verify current projections and search/profile consumers in staging.

There is no generic CRUD endpoint, user-defined profession insertion, in-place
rename/delete or automatic promotion based on ratings/job counts.
