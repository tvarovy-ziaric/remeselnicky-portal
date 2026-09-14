# Public CraftsmanProfile projection

R1-011 exposes a server-authored, field-allowlisted profile read model without
adding a migration or treating the private aggregate as a public DTO.

## Eligibility and consistency

`createPublicCraftsmanProfileRepository().findPublic(profileId)` reads inside a
PostgreSQL `REPEATABLE READ READ ONLY` snapshot. Its first query requires all of
the following in the same authoritative snapshot:

- `current_craftsman_profile_publications.effectively_public = true`;
- review `APPROVED`, owner visibility `PUBLIC`, moderation `ALLOWED`;
- the profile owner account is currently `ACTIVE`;
- the locked publication minimum still resolves a current service area.

The public read path takes no row locks. Missing, hidden, suspended, rejected,
restricted, incomplete, and unknown profiles all produce the same absence. The
API maps that absence to `{ "code": "NOT_FOUND" }` with HTTP 404 and
`Cache-Control: no-store`.

## Explicit public contract

The public serializer copies only these top-level fields, in the D08 display
order: profile id; public identity and about; active professions; coarse
municipality/service radius; server-derived trust summary; platform-only call
to action; portfolio; declared skills and specializations; active indicative
EUR-cent prices; self-declared working-since year; and current verified
credentials.

Declared proficiency and skills always use explicit `SELF_DECLARED` labels.
Evidence-supported profession levels use a separate nullable field. Credentials
are emitted only while the claim is `APPROVED` and not expired according to
PostgreSQL `CURRENT_DATE`; their label is `ADMIN_APPROVED`. The projection does
not derive years of experience or reputation points. Until review and work
aggregates exist, trust uses `customerScore: null`, `reviewCount: 0`, and
`verifiedWorkCount: 0`.

Public display strings are screened again for email, phone, social handle, URL
or domain, exact-address labels, postal-code shape, control characters, and
secret markers. An unsafe legacy value makes the entire profile unavailable;
it is never partially redacted into ambiguous public content.

Public portfolio projects come only from the current `PUBLIC`,
`SELF_DECLARED`/`UNVERIFIED` 0028 projection. Each project exposes allowlisted
text, optional duration and non-contractual EUR-cent range, coarse municipality
and district codes, current safe profession/skill/specialization labels, and
ordered public photo metadata with the opaque media asset ID used by the
separately authorized public delivery path. Current featured candidates sort
first in their explicit order (maximum three); remaining public projects use a
stable project-ID order. Candidate presence never makes a project public.

The contract has no field for email, phone, home/exact address, coordinates,
company registration number, verification references, raw completeness,
credential evidence, media storage keys or hashes, reviewers/reasons, internal
admin state, customer identity/consent records, public storage URLs, or risk
data. Runtime extra properties are discarded by the serializer at the DB and
API boundaries. A missing photo, stale project/publication revision, hidden
profile or project, revoked public object, unsafe project text, or missing
catalog label fails closed.

## Deliberate fail-closed areas

Job-linked/customer-property portfolio provenance remains absent until its
immutable JobParticipant and consent bindings exist. R1 publishes only the
off-platform `SELF_DECLARED` path and labels it `UNVERIFIED`; it never infers
consent or verification from ownership, featured state, or a media asset ID.
Precise R1-006 availability blocks remain private because their migration
explicitly requires a later privacy-reviewed public aggregation and defines no
overlap precedence.

## HTTP and web rendering

The API route is `GET /v1/public/craftsmen/:profileId`. It never serializes a
database exception. An eligible 200 response is `index, follow`; 404 and 503
responses are `noindex, nofollow`. The Next.js page is
`/remeselnici/:profileId`, fetches the route with `cache: "no-store"`, and
re-applies the serializer. Its metadata is `index, follow` only when an eligible
projection is present; all absence states use `noindex, nofollow` and the Next.js
404 boundary. Portfolio cards render the provenance label, allowlisted details,
and ordered photo links through `/v1/public/media/:mediaAssetId`; they never
embed a storage URL. `PORTAL_API_ORIGIN` selects the internal API origin and must
be a credential-free HTTP(S) origin with no path, query, or fragment.
