DROP TRIGGER job_request_commands_insert_guard ON job_request_commands;
DROP FUNCTION validate_job_request_command();
DROP TRIGGER job_request_revisions_insert_guard ON job_request_revisions;
DROP FUNCTION validate_job_request_revision();
DROP TRIGGER job_request_command_effect_required ON job_request_commands;
DROP FUNCTION ensure_job_request_command_effect();

ALTER TABLE job_request_commands
  DROP CONSTRAINT job_request_commands_revisions_valid,
  DROP CONSTRAINT job_request_commands_kind_state_valid;
ALTER TYPE job_request_command_kind RENAME TO job_request_command_kind_0036;
CREATE TYPE job_request_command_kind AS ENUM (
  'CREATE_DRAFT',
  'CREATE_DRAFT_WITH_SECTION',
  'ACTIVATE',
  'AUTOSAVE'
);
ALTER TABLE job_request_commands
  ALTER COLUMN command_kind TYPE job_request_command_kind
  USING command_kind::text::job_request_command_kind;
DROP TYPE job_request_command_kind_0036;

CREATE TYPE job_request_command_result AS ENUM ('APPLIED', 'UNCHANGED');
ALTER TABLE job_request_commands
  ADD COLUMN result_kind job_request_command_result NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN draft_section_key varchar(64),
  ADD COLUMN draft_section_schema_version integer,
  ADD COLUMN draft_payload_fingerprint char(64);

ALTER TABLE job_request_commands
  ADD CONSTRAINT job_request_commands_revisions_valid CHECK (
    expected_revision >= 0 AND (
      (result_kind = 'APPLIED' AND resulting_revision = expected_revision + 1)
      OR (result_kind = 'UNCHANGED' AND command_kind = 'AUTOSAVE'
        AND resulting_revision = expected_revision)
    )
  ),
  ADD CONSTRAINT job_request_commands_kind_state_valid CHECK (
    (command_kind = 'CREATE_DRAFT' AND result_kind = 'APPLIED'
      AND expected_revision = 0 AND resulting_revision = 1
      AND target_state = 'DRAFT'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key IS NULL
      AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL)
    OR (command_kind = 'CREATE_DRAFT_WITH_SECTION'
      AND result_kind = 'APPLIED'
      AND expected_revision = 0 AND resulting_revision = 1
      AND target_state = 'DRAFT'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key ~ '^[a-z][a-z0-9._-]{0,63}$'
      AND draft_section_schema_version BETWEEN 1 AND 65535
      AND draft_payload_fingerprint ~ '^[0-9a-f]{64}$')
    OR (command_kind = 'ACTIVATE' AND result_kind = 'APPLIED'
      AND expected_revision > 0 AND target_state = 'ACTIVE'
      AND submission_eligibility_revision = expected_revision
      AND draft_section_key IS NULL
      AND draft_section_schema_version IS NULL
      AND draft_payload_fingerprint IS NULL)
    OR (command_kind = 'AUTOSAVE' AND expected_revision > 0
      AND target_state = 'DRAFT'
      AND submission_eligibility_revision IS NULL
      AND draft_section_key ~ '^[a-z][a-z0-9._-]{0,63}$'
      AND draft_section_schema_version BETWEEN 1 AND 65535
      AND draft_payload_fingerprint ~ '^[0-9a-f]{64}$')
  );

CREATE TABLE job_request_draft_section_revisions (
  command_id uuid PRIMARY KEY
    REFERENCES job_request_commands(command_id) ON DELETE RESTRICT,
  job_request_id uuid NOT NULL,
  request_revision integer NOT NULL,
  section_key varchar(64) NOT NULL,
  section_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  saved_at timestamptz NOT NULL,
  FOREIGN KEY (job_request_id, request_revision)
    REFERENCES job_request_revisions(job_request_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT job_request_draft_section_revision_once UNIQUE (
    job_request_id, request_revision
  ),
  CONSTRAINT job_request_draft_section_key_valid CHECK (
    section_key ~ '^[a-z][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT job_request_draft_section_schema_version_valid CHECK (
    section_schema_version BETWEEN 1 AND 65535
  ),
  CONSTRAINT job_request_draft_payload_object CHECK (
    jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT job_request_draft_payload_bytes_bounded CHECK (
    octet_length(payload::text) <= 34816
  ),
  CONSTRAINT job_request_draft_payload_fingerprint_sha256 CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX job_request_draft_section_history_idx
  ON job_request_draft_section_revisions (
    job_request_id, section_key, request_revision DESC
  );

CREATE FUNCTION job_request_draft_json_is_bounded(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  WITH RECURSIVE nodes(value, depth) AS (
    SELECT candidate, 0
    UNION ALL
    SELECT child.value, parent.depth + 1
    FROM nodes parent
    CROSS JOIN LATERAL (
      SELECT object_child.value
      FROM jsonb_each(
        CASE WHEN jsonb_typeof(parent.value) = 'object'
          THEN parent.value ELSE '{}'::jsonb END
      ) object_child
      UNION ALL
      SELECT array_child.value
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(parent.value) = 'array'
          THEN parent.value ELSE '[]'::jsonb END
      ) array_child
    ) child
    WHERE parent.depth < 9
  )
  SELECT jsonb_typeof(candidate) = 'object'
    AND COALESCE(max(depth), 0) <= 8
    AND COALESCE(sum(
      CASE WHEN jsonb_typeof(value) = 'object'
        THEN (
          SELECT count(*)::integer FROM jsonb_object_keys(value)
        ) ELSE 0 END
    ), 0) <= 256
    AND COALESCE(sum(
      CASE WHEN jsonb_typeof(value) = 'array'
        THEN jsonb_array_length(value) ELSE 0 END
    ), 0) <= 512
    AND COALESCE(bool_and(
      CASE WHEN jsonb_typeof(value) = 'array'
        THEN jsonb_array_length(value) <= 128 ELSE true END
    ), true)
    AND COALESCE(bool_and(
      CASE WHEN jsonb_typeof(value) = 'string'
        THEN octet_length(value #>> '{}') <= 8192 ELSE true END
    ), true)
    AND NOT EXISTS (
      SELECT 1
      FROM nodes object_node
      CROSS JOIN LATERAL jsonb_object_keys(
        CASE WHEN jsonb_typeof(object_node.value) = 'object'
          THEN object_node.value ELSE '{}'::jsonb END
      ) object_key
      WHERE length(object_key) NOT BETWEEN 1 AND 64
        OR object_key ~ '[[:cntrl:]]'
        OR object_key IN ('__proto__', 'constructor', 'prototype')
    )
  FROM nodes;
$$;

ALTER TABLE job_request_draft_section_revisions
  ADD CONSTRAINT job_request_draft_payload_recursively_bounded CHECK (
    job_request_draft_json_is_bounded(payload)
  );

CREATE VIEW current_job_request_draft_sections AS
SELECT DISTINCT ON (section.job_request_id, section.section_key)
  section.job_request_id,
  section.request_revision,
  section.section_key,
  section.section_schema_version,
  section.payload,
  section.payload_fingerprint,
  section.saved_at
FROM job_request_draft_section_revisions section
JOIN current_job_requests request ON request.id = section.job_request_id
WHERE request.state = 'DRAFT'
  AND section.request_revision <= request.revision
ORDER BY section.job_request_id, section.section_key,
  section.request_revision DESC;

CREATE FUNCTION validate_job_request_command()
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
BEGIN
  SELECT account_state INTO owner_state
  FROM users WHERE id = NEW.actor_user_id FOR UPDATE;
  IF NOT FOUND OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active actor required for job request command';
  END IF;

  SELECT owner_user_id INTO owner_id
  FROM customer_profiles
  WHERE id = NEW.customer_profile_id
  FOR UPDATE;
  IF NOT FOUND OR owner_id <> NEW.actor_user_id THEN
    RAISE EXCEPTION 'owning customer required for job request command';
  END IF;

  SELECT customer_profile_id INTO request_customer_id
  FROM job_requests WHERE id = NEW.job_request_id FOR UPDATE;
  IF NOT FOUND OR request_customer_id <> NEW.customer_profile_id THEN
    RAISE EXCEPTION 'owned job request required for command';
  END IF;

  SELECT * INTO current_revision
  FROM job_request_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;

  IF NEW.command_kind IN ('CREATE_DRAFT', 'CREATE_DRAFT_WITH_SECTION') THEN
    IF current_revision.job_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'job request draft already initialized';
    END IF;
  ELSIF NEW.command_kind = 'ACTIVATE' THEN
    IF current_revision.job_request_id IS NULL
       OR current_revision.state <> 'DRAFT'
       OR current_revision.revision <> NEW.expected_revision THEN
      RAISE EXCEPTION 'job request activation transition is invalid or stale';
    END IF;
    IF cardinality(job_request_missing_submission_requirements(
      NEW.job_request_id, NEW.expected_revision
    )) <> 0 THEN
      RAISE EXCEPTION 'job request submission requirements are not satisfied';
    END IF;
  ELSE
    IF current_revision.job_request_id IS NULL
       OR current_revision.state <> 'DRAFT'
       OR current_revision.revision <> NEW.expected_revision THEN
      RAISE EXCEPTION 'job request autosave requires the exact current draft revision';
    END IF;
    SELECT * INTO current_section
    FROM job_request_draft_section_revisions section
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
  END IF;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_request_commands_insert_guard
BEFORE INSERT ON job_request_commands
FOR EACH ROW EXECUTE FUNCTION validate_job_request_command();

CREATE FUNCTION validate_job_request_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source job_request_commands%ROWTYPE;
  prior job_request_revisions%ROWTYPE;
BEGIN
  SELECT * INTO source FROM job_request_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.result_kind <> 'APPLIED'
     OR source.job_request_id <> NEW.job_request_id
     OR source.resulting_revision <> NEW.revision
     OR source.target_state <> NEW.state THEN
    RAISE EXCEPTION 'job request revision must exactly match its applied command';
  END IF;

  SELECT * INTO prior FROM job_request_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF source.command_kind IN ('CREATE_DRAFT', 'CREATE_DRAFT_WITH_SECTION') THEN
    IF prior.job_request_id IS NOT NULL OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'initial job request revision is invalid';
    END IF;
  ELSIF prior.job_request_id IS NULL
        OR prior.revision <> source.expected_revision
        OR prior.state <> 'DRAFT'
        OR (source.command_kind = 'ACTIVATE' AND NEW.state <> 'ACTIVE')
        OR (source.command_kind = 'AUTOSAVE' AND NEW.state <> 'DRAFT') THEN
    RAISE EXCEPTION 'job request revision transition is invalid';
  END IF;

  NEW.changed_at := source.created_at;
  NEW.activated_at := CASE
    WHEN NEW.state = 'ACTIVE' THEN source.created_at
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_request_revisions_insert_guard
BEFORE INSERT ON job_request_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_request_revision();

CREATE FUNCTION validate_job_request_draft_section_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE source job_request_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM job_request_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.command_kind NOT IN (
       'AUTOSAVE', 'CREATE_DRAFT_WITH_SECTION'
     )
     OR source.result_kind <> 'APPLIED'
     OR source.job_request_id <> NEW.job_request_id
     OR source.resulting_revision <> NEW.request_revision
     OR source.draft_section_key <> NEW.section_key
     OR source.draft_section_schema_version <> NEW.section_schema_version
     OR source.draft_payload_fingerprint <> NEW.payload_fingerprint THEN
    RAISE EXCEPTION 'draft section effect must exactly match applied autosave';
  END IF;
  NEW.saved_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_request_draft_section_revisions_insert_guard
BEFORE INSERT ON job_request_draft_section_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_request_draft_section_revision();

CREATE FUNCTION ensure_job_request_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.result_kind = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM job_request_revisions revision
    WHERE revision.command_id = NEW.command_id
      AND revision.job_request_id = NEW.job_request_id
      AND revision.revision = NEW.resulting_revision
      AND revision.state = NEW.target_state
  ) THEN
    RAISE EXCEPTION 'applied job request command requires an exact revision effect';
  END IF;
  IF NEW.command_kind IN ('AUTOSAVE', 'CREATE_DRAFT_WITH_SECTION')
     AND NEW.result_kind = 'APPLIED'
     AND NOT EXISTS (
       SELECT 1 FROM job_request_draft_section_revisions section
       WHERE section.command_id = NEW.command_id
         AND section.job_request_id = NEW.job_request_id
         AND section.request_revision = NEW.resulting_revision
     ) THEN
    RAISE EXCEPTION 'applied autosave requires an exact section effect';
  END IF;
  IF NEW.result_kind = 'UNCHANGED' AND (
    EXISTS (SELECT 1 FROM job_request_revisions WHERE command_id = NEW.command_id)
    OR EXISTS (
      SELECT 1 FROM job_request_draft_section_revisions
      WHERE command_id = NEW.command_id
    )
  ) THEN
    RAISE EXCEPTION 'unchanged autosave cannot create an effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER job_request_command_effect_required
AFTER INSERT ON job_request_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_job_request_command_effect();

CREATE TRIGGER job_request_draft_section_revisions_append_only
BEFORE UPDATE OR DELETE ON job_request_draft_section_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();

COMMENT ON TABLE job_request_draft_section_revisions IS
  'PRIVATE server draft transport only; never analytics, logs, outbox, or public serialization.';
