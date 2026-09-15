# Job request content sections

R3-004 defines the server-validated content vocabulary placed inside the
private R3-002 autosave envelopes. It does not add a public projection, API,
taxonomy suggestion engine, credential mapping, or profession-specific helper
question set.

## Versioned section contract

The only accepted section keys are `request.core`, `request.location`,
`request.timing`, `request.budget`, `request.details`, and `request.media`.
Every section currently has schema version `1` and a
closed property allowlist. Unknown fields, section versions, enum values,
duplicate identifiers, unsafe text, invalid dates or inconsistent amount
combinations fail before persistence. The normalized result includes the exact
canonical JSON produced by the generic R3-002 envelope normalizer.

- `request.core`: editable title, required-at-submission description and primary
  profession, plus optional related professions, specialization and skills.
- `request.location`: required-at-submission governed municipality reference plus
  optional exact address, exact map pin and clarification. Exact address and pin
  are private and must be omitted from pre-confirmation/public projections.
- `request.timing`: optional `AS_SOON_AS_POSSIBLE`, `SPECIFIC_PERIOD` or `FLEXIBLE`
  choice, optional bounded ISO dates and optional completion deadline.
- `request.budget`: optional `UP_TO`, `RANGE` or `UNKNOWN` choice using positive integer
  EUR cents. Missing budget remains valid and neutral.
- `request.details`: optional material responsibility, site-inspection preference,
  approximate quantity and custom requirements.
- `request.media`: ordered unique media-asset references. Photos have the locked product
  maximum of 10. Documents are optional and use the generic autosave array
  ceiling of 128 only as a technical resource bound. There is deliberately no
  video property.

Draft sections may remain incomplete. Activation readiness checks exactly the
locked minimum: primary profession, non-empty description, and municipality.
Missing title, specialization, skills, timing, budget, exact address, map pin,
details, photos or documents cannot block submission.

## Security and integration boundaries

Multiline text is normalized from CRLF to LF, trimmed and bounded. Unsafe
control characters and embedded email/phone contact bypasses are rejected.
Taxonomy and municipality codes are syntactically validated here; the future
server adapter must additionally resolve them against the currently governed
catalog in the same authorization-aware command boundary.

Media UUIDs are references only. The API/persistence integration must verify
ACTIVE ownership, private media eligibility, canonical processing state and
attachment purpose rather than treating UUID possession as authority. Exact
location and request text must never enter logs, analytics, URLs, notification
previews or public serializers.

R3-003 can pass any normalized section directly to
`CREATE_DRAFT_WITH_SECTION`; ordinary form changes pass the same section shape
to R3-002 `AUTOSAVE`. Future incompatible field changes require a new explicit
section version and migration/parser path rather than silently reinterpreting
stored version `1` JSON.
