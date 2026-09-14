ALTER TYPE media_upload_purpose ADD VALUE IF NOT EXISTS 'CREDENTIAL_IMAGE';

CREATE TYPE credential_evidence_requirement AS ENUM ('REQUIRED', 'OPTIONAL');
CREATE TYPE credential_claim_state AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REVOKED'
);
CREATE TYPE credential_claim_command_kind AS ENUM (
  'CREATE',
  'ATTACH_EVIDENCE',
  'APPROVE',
  'REJECT',
  'REVOKE'
);
CREATE TYPE credential_review_reason_category AS ENUM (
  'INSUFFICIENT_EVIDENCE',
  'FALSE_QUALIFICATION',
  'FALSE_IDENTITY',
  'MISLEADING_CLAIM',
  'EXPIRED_OR_INVALID',
  'OTHER'
);

CREATE FUNCTION credential_review_reason_safe(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT
    value = btrim(value)
    AND length(value) BETWEEN 8 AND 500
    AND value !~ '[[:cntrl:]]'
    AND value !~* '[[:alnum:]_.%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    AND value !~* '\m(https?://|www\.)'
    AND value !~* '\m(bearer|password|heslo|api[ _-]?key|access[ _-]?token|secret)\M'
    AND value !~* '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)';
$$;

-- Server-governed type policy. There is intentionally no owner-facing mutation
-- repository and no product taxonomy is seeded by this migration.
CREATE TABLE credential_type_policies (
  code text PRIMARY KEY,
  evidence_requirement credential_evidence_requirement NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source_reference text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT credential_type_policy_code_safe CHECK (
    length(code) BETWEEN 1 AND 64
    AND code ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+|_[a-z0-9]+|-[a-z0-9]+)*$'
  ),
  CONSTRAINT credential_type_policy_source_safe CHECK (
    source_reference ~ '^[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  )
);

CREATE TABLE credential_claims (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid NOT NULL
    REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  credential_type_code text NOT NULL
    REFERENCES credential_type_policies(code) ON DELETE RESTRICT,
  evidence_requirement credential_evidence_requirement NOT NULL,
  expires_on date,
  state credential_claim_state NOT NULL DEFAULT 'PENDING',
  revision integer NOT NULL DEFAULT 1,
  latest_command_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  review_reason_category credential_review_reason_category,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at timestamptz,
  CONSTRAINT credential_claim_revision_positive CHECK (revision > 0),
  CONSTRAINT credential_claim_review_context_consistent CHECK (
    (state = 'PENDING' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL
      AND review_reason_category IS NULL AND review_reason IS NULL)
    OR (state = 'APPROVED' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND review_reason_category IS NULL AND review_reason IS NULL)
    OR (state IN ('REJECTED', 'REVOKED') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL AND review_reason_category IS NOT NULL
      AND credential_review_reason_safe(review_reason))
  ),
  CONSTRAINT credential_claim_timestamps_ordered CHECK (
    updated_at >= created_at AND (reviewed_at IS NULL OR reviewed_at >= created_at)
  )
);

CREATE INDEX credential_claims_owner_queue_idx
ON credential_claims (craftsman_profile_id, created_at, id);
CREATE INDEX credential_claims_pending_queue_idx
ON credential_claims (created_at, id) WHERE state = 'PENDING';

CREATE TABLE credential_claim_commands (
  command_id uuid PRIMARY KEY,
  command_kind credential_claim_command_kind NOT NULL,
  claim_id uuid NOT NULL REFERENCES credential_claims(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64),
  expected_revision integer NOT NULL,
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  reason_category credential_review_reason_category,
  reason text,
  payload_fingerprint char(64) NOT NULL,
  audit_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT credential_claim_command_fingerprint_safe CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT credential_claim_command_revision_safe CHECK (expected_revision >= 0),
  CONSTRAINT credential_claim_command_shape CHECK (
    (command_kind = 'CREATE' AND expected_revision = 0 AND media_asset_id IS NULL
      AND actor_privileged_session_hash IS NULL AND reason_category IS NULL
      AND reason IS NULL AND audit_event_id IS NULL)
    OR (command_kind = 'ATTACH_EVIDENCE' AND expected_revision > 0
      AND media_asset_id IS NOT NULL AND actor_privileged_session_hash IS NULL
      AND reason_category IS NULL AND reason IS NULL AND audit_event_id IS NULL)
    OR (command_kind = 'APPROVE' AND expected_revision > 0
      AND media_asset_id IS NULL AND actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
      AND reason_category IS NULL AND reason IS NULL AND audit_event_id IS NOT NULL)
    OR (command_kind IN ('REJECT', 'REVOKE') AND expected_revision > 0
      AND media_asset_id IS NULL AND actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
      AND reason_category IS NOT NULL AND credential_review_reason_safe(reason)
      AND audit_event_id IS NOT NULL)
  )
);

CREATE INDEX credential_claim_commands_claim_history_idx
ON credential_claim_commands (claim_id, occurred_at, command_id);

ALTER TABLE credential_claims
ADD CONSTRAINT credential_claims_latest_command_fkey
FOREIGN KEY (latest_command_id) REFERENCES credential_claim_commands(command_id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE credential_claim_commands
ADD CONSTRAINT credential_claim_commands_audit_event_fkey
FOREIGN KEY (audit_event_id) REFERENCES audit_events(event_id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE credential_claim_evidence (
  claim_id uuid NOT NULL REFERENCES credential_claims(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE
    REFERENCES credential_claim_commands(command_id) ON DELETE RESTRICT,
  attached_revision integer NOT NULL,
  media_kind media_kind NOT NULL,
  attached_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attached_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (claim_id, attached_revision),
  CONSTRAINT credential_claim_evidence_revision_safe CHECK (attached_revision > 1)
);

CREATE TABLE credential_claim_decisions (
  command_id uuid PRIMARY KEY
    REFERENCES credential_claim_commands(command_id) ON DELETE RESTRICT,
  claim_id uuid NOT NULL REFERENCES credential_claims(id) ON DELETE RESTRICT,
  from_state credential_claim_state NOT NULL,
  to_state credential_claim_state NOT NULL,
  revision integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason_category credential_review_reason_category,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (claim_id, revision),
  CONSTRAINT credential_claim_decision_revision_safe CHECK (revision > 1),
  CONSTRAINT credential_claim_decision_transition_safe CHECK (
    (from_state = 'PENDING' AND to_state = 'APPROVED'
      AND reason_category IS NULL AND reason IS NULL)
    OR (from_state = 'PENDING' AND to_state = 'REJECTED'
      AND reason_category IS NOT NULL AND credential_review_reason_safe(reason))
    OR (from_state = 'APPROVED' AND to_state = 'REVOKED'
      AND reason_category IS NOT NULL AND credential_review_reason_safe(reason))
  )
);

CREATE TABLE credential_claim_revisions (
  claim_id uuid NOT NULL REFERENCES credential_claims(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES credential_claim_commands(command_id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid NOT NULL REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  credential_type_code text NOT NULL,
  evidence_requirement credential_evidence_requirement NOT NULL,
  expires_on date,
  state credential_claim_state NOT NULL,
  evidence_count integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  review_reason_category credential_review_reason_category,
  review_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (claim_id, revision),
  CONSTRAINT credential_claim_revision_evidence_count_safe CHECK (evidence_count >= 0)
);

CREATE FUNCTION initialize_credential_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  profile_owner_id uuid;
  owner_state user_account_state;
  profession_profile_id uuid;
  profession_state craftsman_profession_state;
  policy_requirement credential_evidence_requirement;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;
  SELECT profession.craftsman_profile_id, profession.state
  INTO profession_profile_id, profession_state
  FROM craftsman_professions profession WHERE profession.id = NEW.craftsman_profession_id
  FOR KEY SHARE;
  SELECT evidence_requirement INTO policy_requirement
  FROM credential_type_policies
  WHERE code = NEW.credential_type_code AND active = true
  FOR KEY SHARE;

  IF profile_owner_id IS DISTINCT FROM NEW.created_by_user_id OR owner_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'active credential claim profile owner required';
  END IF;
  IF profession_profile_id IS DISTINCT FROM NEW.craftsman_profile_id OR profession_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'credential claim profession must be active and owned by the same profile';
  END IF;
  IF policy_requirement IS NULL THEN RAISE EXCEPTION 'active credential type policy required'; END IF;

  NEW.evidence_requirement := policy_requirement;
  NEW.state := 'PENDING'; NEW.revision := 1;
  NEW.updated_by_user_id := NEW.created_by_user_id;
  NEW.reviewed_by_user_id := NULL; NEW.review_reason_category := NULL;
  NEW.review_reason := NULL; NEW.reviewed_at := NULL;
  NEW.created_at := clock_timestamp(); NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credential_claim_insert_guard BEFORE INSERT ON credential_claims
FOR EACH ROW EXECUTE FUNCTION initialize_credential_claim();

CREATE FUNCTION guard_credential_claim_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  command_record credential_claim_commands%ROWTYPE;
  approval_evidence_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credential claim history cannot be hard-deleted'; END IF;
  IF ROW(NEW.id, NEW.craftsman_profile_id, NEW.craftsman_profession_id,
    NEW.credential_type_code, NEW.evidence_requirement, NEW.expires_on,
    NEW.created_by_user_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.craftsman_profile_id, OLD.craftsman_profession_id,
    OLD.credential_type_code, OLD.evidence_requirement, OLD.expires_on,
    OLD.created_by_user_id, OLD.created_at)
  THEN RAISE EXCEPTION 'credential claim identity content and provenance are immutable'; END IF;
  IF NEW.latest_command_id IS NOT DISTINCT FROM OLD.latest_command_id THEN
    RAISE EXCEPTION 'credential claim mutation requires a new command';
  END IF;
  SELECT * INTO command_record FROM credential_claim_commands WHERE command_id = NEW.latest_command_id;
  IF NOT FOUND OR command_record.claim_id IS DISTINCT FROM OLD.id
    OR command_record.expected_revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'credential claim mutation requires matching command provenance';
  END IF;

  IF command_record.command_kind = 'ATTACH_EVIDENCE' THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> OLD.state
      OR ROW(NEW.reviewed_by_user_id, NEW.review_reason_category, NEW.review_reason, NEW.reviewed_at)
         IS DISTINCT FROM ROW(OLD.reviewed_by_user_id, OLD.review_reason_category, OLD.review_reason, OLD.reviewed_at)
    THEN RAISE EXCEPTION 'invalid credential evidence transition'; END IF;
  ELSIF command_record.command_kind = 'APPROVE' THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> 'APPROVED' THEN
      RAISE EXCEPTION 'invalid credential approval transition'; END IF;
    IF OLD.evidence_requirement = 'REQUIRED' THEN
      SELECT true INTO approval_evidence_ok
      FROM credential_claim_evidence evidence
      JOIN media_assets asset ON asset.id = evidence.media_asset_id
      JOIN media_asset_storage_objects object ON object.media_asset_id = asset.id
        AND object.role::text = 'CANONICAL'
        AND object.storage_area::text = 'private'
        AND object.revoked_at IS NULL
      WHERE evidence.claim_id = OLD.id
        AND asset.status::text = 'READY'
        AND asset.owner_user_id = OLD.created_by_user_id
        AND asset.provenance_entity_type::text = 'CREDENTIAL'
        AND asset.provenance_entity_id = OLD.id
        AND (
          (asset.kind::text = 'DOCUMENT' AND asset.purpose::text = 'CREDENTIAL_DOCUMENT')
          OR (asset.kind::text = 'IMAGE' AND asset.purpose::text = 'CREDENTIAL_IMAGE')
        )
      ORDER BY evidence.attached_revision, object.id
      LIMIT 1
      FOR UPDATE OF asset, object;
      IF approval_evidence_ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'required credential evidence must be READY before approval';
      END IF;
    END IF;
    NEW.review_reason_category := NULL; NEW.review_reason := NULL;
  ELSIF command_record.command_kind = 'REJECT' THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> 'REJECTED' THEN
      RAISE EXCEPTION 'invalid credential rejection transition'; END IF;
    NEW.review_reason_category := command_record.reason_category;
    NEW.review_reason := command_record.reason;
  ELSIF command_record.command_kind = 'REVOKE' THEN
    IF OLD.state <> 'APPROVED' OR NEW.state <> 'REVOKED' THEN
      RAISE EXCEPTION 'invalid credential revocation transition'; END IF;
    NEW.review_reason_category := command_record.reason_category;
    NEW.review_reason := command_record.reason;
  ELSE RAISE EXCEPTION 'invalid credential claim mutation command kind';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_by_user_id := command_record.actor_user_id;
  NEW.updated_at := clock_timestamp();
  IF command_record.command_kind IN ('APPROVE', 'REJECT', 'REVOKE') THEN
    NEW.reviewed_by_user_id := command_record.actor_user_id;
    NEW.reviewed_at := NEW.updated_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credential_claim_mutation_guard BEFORE UPDATE OR DELETE ON credential_claims
FOR EACH ROW EXECUTE FUNCTION guard_credential_claim_mutation();

CREATE FUNCTION guard_credential_claim_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim_record credential_claims%ROWTYPE;
  profile_owner_id uuid;
  owner_state user_account_state;
  privileged_ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'credential claim command history is append-only'; END IF;
  SELECT * INTO claim_record FROM credential_claims WHERE id = NEW.claim_id FOR UPDATE;
  IF NOT FOUND OR claim_record.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id THEN
    RAISE EXCEPTION 'credential claim command object mismatch';
  END IF;
  IF NEW.command_kind <> 'CREATE' AND claim_record.revision IS DISTINCT FROM NEW.expected_revision THEN
    RAISE EXCEPTION 'credential claim command has stale revision';
  END IF;
  IF NEW.command_kind IN ('CREATE', 'ATTACH_EVIDENCE') THEN
    SELECT profile.owner_user_id, owner.account_state INTO profile_owner_id, owner_state
    FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id = NEW.craftsman_profile_id FOR UPDATE OF profile, owner;
    IF profile_owner_id IS DISTINCT FROM NEW.actor_user_id OR owner_state IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'active credential claim profile owner required';
    END IF;
  ELSE
    SELECT true INTO privileged_ok
    FROM admin_privileged_sessions privileged
    JOIN auth_sessions base ON base.session_id_hash = privileged.session_id_hash
      AND base.user_id = privileged.user_id AND base.revoked_at IS NULL
      AND base.expires_at > clock_timestamp()
    JOIN users actor ON actor.id = privileged.user_id AND actor.account_state = 'ACTIVE'
    JOIN admin_mfa_factors factor ON factor.id = privileged.mfa_factor_id
      AND factor.user_id = privileged.user_id AND factor.revoked_at IS NULL
    JOIN admin_role_grants role ON role.user_id = privileged.user_id
      AND role.revoked_at IS NULL AND role.role IN ('ADMIN', 'SUPER_ADMIN')
    WHERE privileged.session_id_hash = NEW.actor_privileged_session_hash
      AND privileged.user_id = NEW.actor_user_id AND privileged.revoked_at IS NULL
      AND privileged.expires_at > clock_timestamp()
      AND privileged.mfa_authenticated_at >= clock_timestamp() - interval '15 minutes'
    ORDER BY role.role
    LIMIT 1
    FOR UPDATE OF privileged, base, actor, factor, role;
    IF privileged_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'active MFA-backed credential review capability required';
    END IF;
  END IF;
  NEW.occurred_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER credential_claim_commands_guard
BEFORE INSERT OR UPDATE OR DELETE ON credential_claim_commands
FOR EACH ROW EXECUTE FUNCTION guard_credential_claim_command();

CREATE FUNCTION guard_credential_claim_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  command_record credential_claim_commands%ROWTYPE;
  claim_owner_id uuid;
  claim_state credential_claim_state;
  asset_record media_assets%ROWTYPE;
  canonical_object media_asset_storage_objects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'credential evidence history is append-only'; END IF;
  SELECT * INTO command_record FROM credential_claim_commands WHERE command_id = NEW.command_id;
  SELECT claim.created_by_user_id, claim.state INTO claim_owner_id, claim_state
  FROM credential_claims claim WHERE claim.id = NEW.claim_id FOR UPDATE;
  SELECT * INTO asset_record
  FROM media_assets asset
  WHERE asset.id = NEW.media_asset_id
  FOR UPDATE;
  SELECT * INTO canonical_object
  FROM media_asset_storage_objects object
  WHERE object.media_asset_id = asset_record.id
    AND object.role::text = 'CANONICAL'
    AND object.storage_area::text = 'private'
    AND object.revoked_at IS NULL
  ORDER BY object.id
  LIMIT 1
  FOR UPDATE;
  IF command_record.command_kind IS DISTINCT FROM 'ATTACH_EVIDENCE'
    OR command_record.claim_id IS DISTINCT FROM NEW.claim_id
    OR command_record.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR NEW.attached_revision IS DISTINCT FROM command_record.expected_revision + 1
    OR NEW.attached_by_user_id IS DISTINCT FROM command_record.actor_user_id
    OR claim_state IS DISTINCT FROM 'PENDING'
  THEN RAISE EXCEPTION 'credential evidence requires matching pending command provenance'; END IF;
  IF asset_record.owner_user_id IS DISTINCT FROM claim_owner_id
    OR asset_record.status::text <> 'READY'
    OR asset_record.kind::text NOT IN ('DOCUMENT', 'IMAGE')
    OR (asset_record.kind::text = 'DOCUMENT' AND asset_record.purpose::text <> 'CREDENTIAL_DOCUMENT')
    OR (asset_record.kind::text = 'IMAGE' AND asset_record.purpose::text <> 'CREDENTIAL_IMAGE')
    OR asset_record.provenance_entity_type::text <> 'CREDENTIAL'
    OR asset_record.provenance_entity_id IS DISTINCT FROM NEW.claim_id
    OR asset_record.provenance_entity_revision IS DISTINCT FROM command_record.expected_revision
    OR canonical_object.id IS NULL
  THEN RAISE EXCEPTION 'credential evidence must be owned READY private credential media'; END IF;
  NEW.media_kind := asset_record.kind;
  NEW.attached_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER credential_claim_evidence_guard
BEFORE INSERT OR UPDATE OR DELETE ON credential_claim_evidence
FOR EACH ROW EXECUTE FUNCTION guard_credential_claim_evidence();

CREATE FUNCTION guard_attached_credential_media_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM credential_claim_evidence evidence WHERE evidence.media_asset_id = OLD.id
  ) AND ROW(
    NEW.id, NEW.owner_user_id, NEW.uploaded_by_user_id, NEW.kind, NEW.purpose,
    NEW.provenance_entity_type, NEW.provenance_entity_id,
    NEW.provenance_entity_revision, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.owner_user_id, OLD.uploaded_by_user_id, OLD.kind, OLD.purpose,
    OLD.provenance_entity_type, OLD.provenance_entity_id,
    OLD.provenance_entity_revision, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'attached credential media identity and provenance are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attached_credential_media_identity_guard
BEFORE UPDATE ON media_assets
FOR EACH ROW EXECUTE FUNCTION guard_attached_credential_media_identity();

CREATE FUNCTION guard_attached_credential_canonical_object()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role::text = 'CANONICAL' AND EXISTS (
    SELECT 1 FROM credential_claim_evidence evidence
    WHERE evidence.media_asset_id = OLD.media_asset_id
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'attached credential canonical evidence cannot be deleted';
    END IF;
    IF ROW(NEW.id, NEW.media_asset_id, NEW.role, NEW.storage_area, NEW.storage_key,
      NEW.content_type, NEW.byte_size, NEW.content_sha256, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.media_asset_id, OLD.role, OLD.storage_area,
      OLD.storage_key, OLD.content_type, OLD.byte_size, OLD.content_sha256, OLD.created_at)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    THEN
      RAISE EXCEPTION 'attached credential canonical evidence provenance is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attached_credential_canonical_object_guard
BEFORE UPDATE OR DELETE ON media_asset_storage_objects
FOR EACH ROW EXECUTE FUNCTION guard_attached_credential_canonical_object();

CREATE FUNCTION guard_credential_claim_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_record credential_claim_commands%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'credential decisions are append-only'; END IF;
  SELECT * INTO command_record FROM credential_claim_commands WHERE command_id = NEW.command_id;
  IF NOT FOUND OR command_record.claim_id IS DISTINCT FROM NEW.claim_id
    OR command_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR NEW.revision IS DISTINCT FROM command_record.expected_revision + 1
    OR NEW.reason_category IS DISTINCT FROM command_record.reason_category
    OR NEW.reason IS DISTINCT FROM command_record.reason
    OR (command_record.command_kind = 'APPROVE' AND (NEW.from_state <> 'PENDING' OR NEW.to_state <> 'APPROVED'))
    OR (command_record.command_kind = 'REJECT' AND (NEW.from_state <> 'PENDING' OR NEW.to_state <> 'REJECTED'))
    OR (command_record.command_kind = 'REVOKE' AND (NEW.from_state <> 'APPROVED' OR NEW.to_state <> 'REVOKED'))
  THEN RAISE EXCEPTION 'credential decision requires matching review command provenance'; END IF;
  NEW.occurred_at := command_record.occurred_at; RETURN NEW;
END;
$$;
CREATE TRIGGER credential_claim_decisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON credential_claim_decisions
FOR EACH ROW EXECUTE FUNCTION guard_credential_claim_decision();

CREATE FUNCTION guard_credential_claim_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_record credential_claim_commands%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'credential claim revision history is append-only'; END IF;
  SELECT * INTO command_record FROM credential_claim_commands WHERE command_id = NEW.command_id;
  IF NOT FOUND OR command_record.claim_id IS DISTINCT FROM NEW.claim_id
    OR command_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR NEW.revision IS DISTINCT FROM command_record.expected_revision + 1
  THEN RAISE EXCEPTION 'credential claim revision requires matching command provenance'; END IF;
  NEW.occurred_at := command_record.occurred_at; RETURN NEW;
END;
$$;
CREATE TRIGGER credential_claim_revisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON credential_claim_revisions
FOR EACH ROW EXECUTE FUNCTION guard_credential_claim_revision();

CREATE FUNCTION reject_credential_type_policy_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'credential type policies are server-installed and immutable'; END;
$$;
CREATE TRIGGER credential_type_policy_immutable
BEFORE UPDATE OR DELETE ON credential_type_policies
FOR EACH ROW EXECUTE FUNCTION reject_credential_type_policy_mutation();

CREATE FUNCTION assert_credential_claim_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot credential_claim_revisions%ROWTYPE;
  current_claim credential_claims%ROWTYPE;
  decision credential_claim_decisions%ROWTYPE;
  audit audit_events%ROWTYPE;
BEGIN
  SELECT * INTO snapshot FROM credential_claim_revisions WHERE command_id = NEW.command_id;
  SELECT * INTO current_claim FROM credential_claims WHERE id = NEW.claim_id;
  IF snapshot.command_id IS NULL OR current_claim.latest_command_id IS DISTINCT FROM NEW.command_id
    OR current_claim.revision IS DISTINCT FROM snapshot.revision
  THEN RAISE EXCEPTION 'credential claim command requires exactly one current revision effect'; END IF;
  IF NEW.command_kind = 'ATTACH_EVIDENCE' AND NOT EXISTS (
    SELECT 1 FROM credential_claim_evidence evidence WHERE evidence.command_id = NEW.command_id
  ) THEN RAISE EXCEPTION 'credential evidence command requires one attachment effect'; END IF;
  IF NEW.command_kind IN ('APPROVE', 'REJECT', 'REVOKE') THEN
    SELECT * INTO decision FROM credential_claim_decisions WHERE command_id = NEW.command_id;
    SELECT * INTO audit FROM audit_events WHERE event_id = NEW.audit_event_id;
    IF decision.command_id IS NULL OR audit.event_id IS NULL
      OR audit.category::text <> 'PRIVILEGED_COMMAND'
      OR audit.actor_user_id IS DISTINCT FROM NEW.actor_user_id
      OR audit.actor_capability IS DISTINCT FROM 'admin.credentials.review'
      OR audit.correlation_id IS DISTINCT FROM NEW.command_id
      OR audit.target_type IS DISTINCT FROM 'CREDENTIAL_CLAIM'
      OR audit.target_id IS DISTINCT FROM NEW.claim_id::text
      OR audit.action_type IS DISTINCT FROM (CASE NEW.command_kind
        WHEN 'APPROVE' THEN 'admin.credential.approved'
        WHEN 'REJECT' THEN 'admin.credential.rejected'
        ELSE 'admin.credential.revoked'
      END)
      OR audit.changes IS DISTINCT FROM jsonb_build_object(
        'credential_state',
        jsonb_build_object(
          'before', decision.from_state::text,
          'after', decision.to_state::text
        )
      )
      OR (NEW.command_kind IN ('REJECT', 'REVOKE')
        AND audit.reason IS DISTINCT FROM NEW.reason)
    THEN RAISE EXCEPTION 'credential review command requires matching decision and audit effects'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credential_claim_command_effect_required
AFTER INSERT ON credential_claim_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_credential_claim_command_effect();

CREATE FUNCTION assert_credential_claim_current_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot credential_claim_revisions%ROWTYPE; revision_count integer; evidence_count integer;
BEGIN
  SELECT * INTO snapshot FROM credential_claim_revisions
  WHERE claim_id = NEW.id AND revision = NEW.revision;
  SELECT count(*)::integer INTO revision_count FROM credential_claim_revisions WHERE claim_id = NEW.id;
  SELECT count(*)::integer INTO evidence_count FROM credential_claim_evidence WHERE claim_id = NEW.id;
  IF snapshot.command_id IS NULL OR snapshot.command_id IS DISTINCT FROM NEW.latest_command_id
    OR snapshot.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR snapshot.craftsman_profession_id IS DISTINCT FROM NEW.craftsman_profession_id
    OR snapshot.credential_type_code IS DISTINCT FROM NEW.credential_type_code
    OR snapshot.evidence_requirement IS DISTINCT FROM NEW.evidence_requirement
    OR snapshot.expires_on IS DISTINCT FROM NEW.expires_on
    OR snapshot.state IS DISTINCT FROM NEW.state
    OR snapshot.evidence_count IS DISTINCT FROM evidence_count
    OR snapshot.reviewed_by_user_id IS DISTINCT FROM NEW.reviewed_by_user_id
    OR snapshot.review_reason_category IS DISTINCT FROM NEW.review_reason_category
    OR snapshot.review_reason IS DISTINCT FROM NEW.review_reason
    OR snapshot.created_at IS DISTINCT FROM NEW.created_at
    OR snapshot.updated_at IS DISTINCT FROM NEW.updated_at
    OR snapshot.reviewed_at IS DISTINCT FROM NEW.reviewed_at
    OR revision_count IS DISTINCT FROM NEW.revision
  THEN RAISE EXCEPTION 'credential claim current state requires contiguous immutable provenance'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credential_claim_current_provenance_required
AFTER INSERT OR UPDATE ON credential_claims DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_credential_claim_current_provenance();
