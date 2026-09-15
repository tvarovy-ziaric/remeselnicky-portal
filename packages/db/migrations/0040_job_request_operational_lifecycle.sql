ALTER TYPE job_request_state ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE job_request_state ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE job_request_command_kind ADD VALUE IF NOT EXISTS 'EXTEND';
ALTER TYPE job_request_command_kind ADD VALUE IF NOT EXISTS 'EXPIRE';
ALTER TYPE job_request_command_kind ADD VALUE IF NOT EXISTS 'REACTIVATE';
ALTER TYPE job_request_command_kind ADD VALUE IF NOT EXISTS 'CANCEL';

CREATE TYPE job_request_cancellation_reason AS ENUM (
  'DUPLICATE', 'NO_LONGER_NEEDED', 'OTHER', 'PLANS_CHANGED'
);

CREATE TABLE job_request_runtime_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_request_limit integer NOT NULL DEFAULT 5
    CHECK (active_request_limit BETWEEN 1 AND 100),
  inactivity_days integer NOT NULL DEFAULT 30
    CHECK (inactivity_days BETWEEN 1 AND 3650),
  warning_lead_days integer NOT NULL DEFAULT 7,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_request_runtime_policy_warning_valid CHECK (
    warning_lead_days BETWEEN 0 AND inactivity_days
  )
);
INSERT INTO job_request_runtime_policy DEFAULT VALUES;

ALTER TABLE job_request_commands
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN system_initiated boolean NOT NULL DEFAULT false,
  ADD COLUMN cancellation_reason job_request_cancellation_reason,
  DROP CONSTRAINT job_request_commands_revisions_valid,
  DROP CONSTRAINT job_request_commands_kind_state_valid;

ALTER TABLE job_request_commands
  ADD CONSTRAINT job_request_commands_revisions_valid CHECK (
    expected_revision >= 0 AND (
      (result_kind = 'APPLIED' AND resulting_revision = expected_revision + 1)
      OR (result_kind = 'UNCHANGED' AND command_kind::text = 'AUTOSAVE'
        AND resulting_revision = expected_revision)
    )
  ),
  ADD CONSTRAINT job_request_commands_actor_shape CHECK (
    (command_kind::text = 'EXPIRE' AND system_initiated
      AND actor_user_id IS NULL)
    OR (command_kind::text <> 'EXPIRE' AND NOT system_initiated
      AND actor_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT job_request_commands_kind_state_valid CHECK (
    (command_kind::text = 'CREATE_DRAFT' AND result_kind = 'APPLIED'
      AND expected_revision = 0 AND resulting_revision = 1
      AND target_state::text = 'DRAFT'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key IS NULL
      AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL
      AND cancellation_reason IS NULL)
    OR (command_kind::text = 'CREATE_DRAFT_WITH_SECTION'
      AND result_kind = 'APPLIED'
      AND expected_revision = 0 AND resulting_revision = 1
      AND target_state::text = 'DRAFT'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key ~ '^[a-z][a-z0-9._-]{0,63}$'
      AND draft_section_schema_version BETWEEN 1 AND 65535
      AND draft_payload_fingerprint ~ '^[0-9a-f]{64}$'
      AND cancellation_reason IS NULL)
    OR (command_kind::text = 'ACTIVATE' AND result_kind = 'APPLIED'
      AND expected_revision > 0 AND target_state::text = 'ACTIVE'
      AND submission_eligibility_revision = expected_revision
      AND draft_section_key IS NULL
      AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL
      AND cancellation_reason IS NULL)
    OR (command_kind::text = 'AUTOSAVE' AND expected_revision > 0
      AND target_state::text = 'DRAFT'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key ~ '^[a-z][a-z0-9._-]{0,63}$'
      AND draft_section_schema_version BETWEEN 1 AND 65535
      AND draft_payload_fingerprint ~ '^[0-9a-f]{64}$'
      AND cancellation_reason IS NULL)
    OR (command_kind::text = 'EXTEND' AND result_kind = 'APPLIED'
      AND expected_revision > 0 AND target_state::text = 'ACTIVE'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key IS NULL AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL AND cancellation_reason IS NULL)
    OR (command_kind::text = 'EXPIRE' AND result_kind = 'APPLIED'
      AND expected_revision > 0 AND target_state::text = 'EXPIRED'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key IS NULL AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL AND cancellation_reason IS NULL)
    OR (command_kind::text = 'REACTIVATE' AND result_kind = 'APPLIED'
      AND expected_revision > 0 AND target_state::text = 'ACTIVE'
      AND submission_eligibility_revision > 0
      AND draft_section_key IS NULL AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL AND cancellation_reason IS NULL)
    OR (command_kind::text = 'CANCEL' AND result_kind = 'APPLIED'
      AND expected_revision > 0 AND target_state::text = 'CANCELLED'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key IS NULL AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL AND cancellation_reason IS NOT NULL)
  );

ALTER TABLE job_request_revisions
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN cancellation_reason job_request_cancellation_reason,
  DROP CONSTRAINT job_request_revisions_activation_consistent;

UPDATE job_request_revisions revision
SET expires_at = revision.changed_at
  + make_interval(days => policy.inactivity_days)
FROM job_request_runtime_policy policy
WHERE revision.state::text = 'ACTIVE';

ALTER TABLE job_request_revisions
  ADD CONSTRAINT job_request_revisions_activation_consistent CHECK (
    (state::text = 'DRAFT' AND activated_at IS NULL
      AND expires_at IS NULL AND cancellation_reason IS NULL)
    OR (state::text = 'ACTIVE' AND activated_at IS NOT NULL
      AND expires_at IS NOT NULL AND cancellation_reason IS NULL)
    OR (state::text = 'EXPIRED' AND activated_at IS NOT NULL
      AND expires_at IS NOT NULL AND cancellation_reason IS NULL)
    OR (state::text = 'CANCELLED' AND activated_at IS NOT NULL
      AND expires_at IS NULL AND cancellation_reason IS NOT NULL)
  );

CREATE OR REPLACE VIEW current_job_requests AS
SELECT DISTINCT ON (request.id)
  request.id,
  request.customer_profile_id,
  revision.state,
  revision.revision,
  request.created_at,
  revision.changed_at,
  revision.activated_at,
  revision.expires_at,
  revision.cancellation_reason
FROM job_requests request
JOIN job_request_revisions revision ON revision.job_request_id = request.id
ORDER BY request.id, revision.revision DESC;

CREATE FUNCTION job_request_active_missing_submission_requirements(
  candidate_request_id uuid,
  candidate_content_revision integer
)
RETURNS job_request_submission_requirement[]
LANGUAGE sql
STABLE
AS $$
  WITH content AS (
    SELECT DISTINCT ON (section.section_key)
      section.section_key, section.payload
    FROM job_request_active_section_revisions section
    WHERE section.job_request_id = candidate_request_id
      AND section.content_revision <= candidate_content_revision
    ORDER BY section.section_key, section.content_revision DESC
  ), core AS (
    SELECT payload FROM content WHERE section_key = 'request.core'
  ), location AS (
    SELECT payload FROM content WHERE section_key = 'request.location'
  )
  SELECT ARRAY_REMOVE(ARRAY[
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM core
      JOIN current_profession_taxonomy profession
        ON profession.profession_code = core.payload ->> 'primaryProfessionCode'
       AND profession.state = 'ACTIVE'
    ) THEN 'PRIMARY_PROFESSION'::job_request_submission_requirement END,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM core
      WHERE length(btrim(core.payload ->> 'description')) BETWEEN 1 AND 4000
    ) THEN 'DESCRIPTION'::job_request_submission_requirement END,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM location
      JOIN location_municipalities municipality
        ON municipality.code = location.payload ->> 'municipalityCode'
       AND municipality.is_active
    ) THEN 'MUNICIPALITY'::job_request_submission_requirement END
  ], NULL);
$$;

CREATE FUNCTION job_request_effective_expires_at(candidate_request_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT GREATEST(current.changed_at, active.changed_at)
    + make_interval(days => policy.inactivity_days)
  FROM current_job_requests current
  JOIN current_job_request_active_content_versions active
    ON active.job_request_id = current.id
  CROSS JOIN job_request_runtime_policy policy
  WHERE current.id = candidate_request_id AND current.state::text = 'ACTIVE';
$$;

CREATE VIEW current_job_request_operational_status AS
SELECT current.id AS job_request_id, current.customer_profile_id,
  current.state, current.revision, current.changed_at,
  current.activated_at, current.cancellation_reason,
  CASE WHEN current.state::text = 'ACTIVE'
    THEN job_request_effective_expires_at(current.id)
    ELSE current.expires_at
  END AS expires_at,
  CASE WHEN current.state::text = 'ACTIVE'
    THEN job_request_effective_expires_at(current.id)
      - make_interval(days => policy.warning_lead_days)
    ELSE NULL
  END AS warning_at
FROM current_job_requests current
CROSS JOIN job_request_runtime_policy policy;

CREATE OR REPLACE FUNCTION create_job_request_active_content_baseline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state::text <> 'ACTIVE' OR EXISTS (
    SELECT 1 FROM job_request_active_content_revisions content
    WHERE content.job_request_id = NEW.job_request_id
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO job_request_active_content_revisions (
    job_request_id, content_revision, visible_version,
    source_request_revision, command_id, material_change,
    change_categories, changed_at
  ) VALUES (
    NEW.job_request_id, 1, 1, NEW.revision, NULL, false,
    ARRAY[]::job_request_material_change_category[], NEW.changed_at
  );
  INSERT INTO job_request_active_section_revisions (
    job_request_id, content_revision, command_id, section_key,
    section_schema_version, payload, payload_fingerprint, saved_at
  )
  SELECT NEW.job_request_id, 1, NULL, source.section_key,
    source.section_schema_version, source.payload,
    source.payload_fingerprint, NEW.changed_at
  FROM (
    SELECT DISTINCT ON (section.section_key) section.*
    FROM job_request_draft_section_revisions section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.request_revision <= NEW.revision
    ORDER BY section.section_key, section.request_revision DESC
  ) source;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_job_request_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision job_request_revisions%ROWTYPE;
  current_section job_request_draft_section_revisions%ROWTYPE;
  owner_id uuid;
  owner_state user_account_state;
  request_customer_id uuid;
  section_count integer;
  active_count integer;
  active_limit integer;
  effective_expiry timestamptz;
  kind text := NEW.command_kind::text;
BEGIN
  IF kind = 'EXPIRE' THEN
    IF NOT NEW.system_initiated OR NEW.actor_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'expiry must be system initiated';
    END IF;
    SELECT owner_user_id INTO owner_id FROM customer_profiles
    WHERE id = NEW.customer_profile_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'customer required for expiry'; END IF;
  ELSE
    SELECT account_state INTO owner_state
    FROM users WHERE id = NEW.actor_user_id FOR UPDATE;
    IF NOT FOUND OR owner_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'active actor required for job request command';
    END IF;
    SELECT owner_user_id INTO owner_id FROM customer_profiles
    WHERE id = NEW.customer_profile_id FOR UPDATE;
    IF NOT FOUND OR owner_id <> NEW.actor_user_id THEN
      RAISE EXCEPTION 'owning customer required for job request command';
    END IF;
  END IF;

  SELECT customer_profile_id INTO request_customer_id
  FROM job_requests WHERE id = NEW.job_request_id FOR UPDATE;
  IF NOT FOUND OR request_customer_id <> NEW.customer_profile_id THEN
    RAISE EXCEPTION 'owned job request required for command';
  END IF;
  SELECT * INTO current_revision FROM job_request_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;

  IF kind IN ('CREATE_DRAFT', 'CREATE_DRAFT_WITH_SECTION') THEN
    IF current_revision.job_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'job request draft already initialized';
    END IF;
  ELSIF kind = 'ACTIVATE' THEN
    IF current_revision.job_request_id IS NULL
       OR current_revision.state::text <> 'DRAFT'
       OR current_revision.revision <> NEW.expected_revision THEN
      RAISE EXCEPTION 'job request activation transition is invalid or stale';
    END IF;
    IF cardinality(job_request_missing_submission_requirements(
      NEW.job_request_id, NEW.expected_revision
    )) <> 0 THEN
      RAISE EXCEPTION 'job request submission requirements are not satisfied';
    END IF;
  ELSIF kind = 'AUTOSAVE' THEN
    IF current_revision.job_request_id IS NULL
       OR current_revision.state::text <> 'DRAFT'
       OR current_revision.revision <> NEW.expected_revision THEN
      RAISE EXCEPTION 'job request autosave requires the exact current draft revision';
    END IF;
    SELECT * INTO current_section FROM job_request_draft_section_revisions section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.section_key = NEW.draft_section_key
      AND section.request_revision <= current_revision.revision
    ORDER BY section.request_revision DESC LIMIT 1;
    IF current_section.command_id IS NOT NULL
       AND current_section.section_schema_version = NEW.draft_section_schema_version
       AND current_section.payload_fingerprint = NEW.draft_payload_fingerprint THEN
      IF NEW.result_kind <> 'UNCHANGED'
         OR NEW.resulting_revision <> NEW.expected_revision THEN
        RAISE EXCEPTION 'equivalent draft autosave must be unchanged';
      END IF;
    ELSE
      IF NEW.result_kind <> 'APPLIED'
         OR NEW.resulting_revision <> NEW.expected_revision + 1 THEN
        RAISE EXCEPTION 'changed draft autosave must append one revision';
      END IF;
      IF current_section.command_id IS NULL THEN
        SELECT count(*)::integer INTO section_count
        FROM current_job_request_draft_sections section
        WHERE section.job_request_id = NEW.job_request_id;
        IF section_count >= 32 THEN
          RAISE EXCEPTION 'job request current section limit reached';
        END IF;
      END IF;
    END IF;
  ELSIF kind = 'EXTEND' THEN
    effective_expiry := job_request_effective_expires_at(NEW.job_request_id);
    IF current_revision.state::text <> 'ACTIVE'
       OR current_revision.revision <> NEW.expected_revision
       OR effective_expiry IS NULL OR clock_timestamp() >= effective_expiry THEN
      RAISE EXCEPTION 'only a current nonexpired active request can be extended';
    END IF;
  ELSIF kind = 'EXPIRE' THEN
    effective_expiry := job_request_effective_expires_at(NEW.job_request_id);
    IF current_revision.state::text <> 'ACTIVE'
       OR current_revision.revision <> NEW.expected_revision
       OR effective_expiry IS NULL OR clock_timestamp() < effective_expiry THEN
      RAISE EXCEPTION 'job request is not eligible for expiry';
    END IF;
  ELSIF kind = 'REACTIVATE' THEN
    IF current_revision.state::text <> 'EXPIRED'
       OR current_revision.revision <> NEW.expected_revision
       OR NEW.submission_eligibility_revision IS DISTINCT FROM
         (SELECT max(content_revision)
          FROM job_request_active_content_revisions
          WHERE job_request_id = NEW.job_request_id)
       OR cardinality(job_request_active_missing_submission_requirements(
         NEW.job_request_id,
         NEW.submission_eligibility_revision
       )) <> 0 THEN
      RAISE EXCEPTION 'job request is not eligible for reactivation';
    END IF;
  ELSIF kind = 'CANCEL' THEN
    IF current_revision.state::text <> 'ACTIVE'
       OR current_revision.revision <> NEW.expected_revision THEN
      RAISE EXCEPTION 'job request cancellation transition is invalid or stale';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported job request command';
  END IF;

  IF kind IN ('ACTIVATE', 'REACTIVATE') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(NEW.customer_profile_id::text, 40006)
    );
    SELECT active_request_limit INTO active_limit FROM job_request_runtime_policy;
    SELECT count(*)::integer INTO active_count FROM current_job_requests current
    WHERE current.customer_profile_id = NEW.customer_profile_id
      AND current.state::text = 'ACTIVE';
    IF active_count >= active_limit THEN
      RAISE EXCEPTION 'active job request limit reached';
    END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_job_request_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source job_request_commands%ROWTYPE;
  prior job_request_revisions%ROWTYPE;
  inactivity integer;
  kind text;
BEGIN
  SELECT * INTO source FROM job_request_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.result_kind <> 'APPLIED'
     OR source.job_request_id <> NEW.job_request_id
     OR source.resulting_revision <> NEW.revision
     OR source.target_state <> NEW.state THEN
    RAISE EXCEPTION 'job request revision must exactly match its applied command';
  END IF;
  kind := source.command_kind::text;
  SELECT * INTO prior FROM job_request_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF kind IN ('CREATE_DRAFT', 'CREATE_DRAFT_WITH_SECTION') THEN
    IF prior.job_request_id IS NOT NULL OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'initial job request revision is invalid';
    END IF;
  ELSIF prior.job_request_id IS NULL
        OR prior.revision <> source.expected_revision
        OR (kind = 'ACTIVATE' AND (prior.state::text <> 'DRAFT'
          OR NEW.state::text <> 'ACTIVE'))
        OR (kind = 'AUTOSAVE' AND (prior.state::text <> 'DRAFT'
          OR NEW.state::text <> 'DRAFT'))
        OR (kind = 'EXTEND' AND (prior.state::text <> 'ACTIVE'
          OR NEW.state::text <> 'ACTIVE'))
        OR (kind = 'EXPIRE' AND (prior.state::text <> 'ACTIVE'
          OR NEW.state::text <> 'EXPIRED'))
        OR (kind = 'REACTIVATE' AND (prior.state::text <> 'EXPIRED'
          OR NEW.state::text <> 'ACTIVE'))
        OR (kind = 'CANCEL' AND (prior.state::text <> 'ACTIVE'
          OR NEW.state::text <> 'CANCELLED')) THEN
    RAISE EXCEPTION 'job request revision transition is invalid';
  END IF;
  SELECT inactivity_days INTO inactivity FROM job_request_runtime_policy;
  NEW.changed_at := source.created_at;
  NEW.activated_at := CASE
    WHEN kind IN ('ACTIVATE', 'REACTIVATE') THEN source.created_at
    WHEN kind IN ('EXTEND', 'EXPIRE', 'CANCEL') THEN prior.activated_at
    ELSE NULL
  END;
  NEW.expires_at := CASE
    WHEN NEW.state::text = 'ACTIVE'
      THEN source.created_at + make_interval(days => inactivity)
    WHEN NEW.state::text = 'EXPIRED'
      THEN job_request_effective_expires_at(NEW.job_request_id)
    ELSE NULL
  END;
  NEW.cancellation_reason := CASE WHEN kind = 'CANCEL'
    THEN source.cancellation_reason ELSE NULL END;
  RETURN NEW;
END;
$$;

CREATE FUNCTION ensure_active_request_content_remains_ready()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(job_request_active_missing_submission_requirements(
    NEW.job_request_id, NEW.content_revision
  )) <> 0 THEN
    RAISE EXCEPTION 'active job request content must remain submission ready';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER job_request_active_content_ready
AFTER INSERT ON job_request_active_content_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.content_revision > 1)
EXECUTE FUNCTION ensure_active_request_content_remains_ready();

COMMENT ON TABLE job_request_runtime_policy IS
  'Offline-configurable alpha policy; no customer/public mutation API.';
COMMENT ON VIEW current_job_request_operational_status IS
  'Current request lifecycle with inactivity expiry derived from authoritative activity.';
