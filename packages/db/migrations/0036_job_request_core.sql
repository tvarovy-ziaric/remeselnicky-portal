CREATE TYPE job_request_state AS ENUM ('DRAFT', 'ACTIVE');
CREATE TYPE job_request_command_kind AS ENUM ('CREATE_DRAFT', 'ACTIVATE');
CREATE TYPE job_request_submission_requirement AS ENUM (
  'PRIMARY_PROFESSION',
  'DESCRIPTION',
  'MUNICIPALITY'
);

CREATE TABLE job_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX job_requests_customer_created_idx
  ON job_requests (customer_profile_id, created_at DESC, id);

CREATE TABLE job_request_commands (
  command_id uuid PRIMARY KEY,
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_kind job_request_command_kind NOT NULL,
  expected_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  target_state job_request_state NOT NULL,
  submission_eligibility_revision integer,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_request_commands_revisions_valid CHECK (
    expected_revision >= 0 AND resulting_revision = expected_revision + 1
  ),
  CONSTRAINT job_request_commands_kind_state_valid CHECK (
    (command_kind = 'CREATE_DRAFT' AND expected_revision = 0
      AND resulting_revision = 1 AND target_state = 'DRAFT'
      AND submission_eligibility_revision IS NULL)
    OR (command_kind = 'ACTIVATE' AND expected_revision > 0
      AND target_state = 'ACTIVE'
      AND submission_eligibility_revision = expected_revision)
  ),
  CONSTRAINT job_request_commands_fingerprint_sha256 CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX job_request_commands_request_history_idx
  ON job_request_commands (job_request_id, created_at, command_id);
CREATE INDEX job_request_commands_customer_history_idx
  ON job_request_commands (customer_profile_id, created_at DESC, command_id);

CREATE TABLE job_request_revisions (
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES job_request_commands(command_id) ON DELETE RESTRICT,
  state job_request_state NOT NULL,
  changed_at timestamptz NOT NULL,
  activated_at timestamptz,
  PRIMARY KEY (job_request_id, revision),
  CONSTRAINT job_request_revisions_positive CHECK (revision > 0),
  CONSTRAINT job_request_revisions_activation_consistent CHECK (
    (state = 'DRAFT' AND activated_at IS NULL)
    OR (state = 'ACTIVE' AND activated_at IS NOT NULL)
  )
);

CREATE VIEW current_job_requests AS
SELECT DISTINCT ON (request.id)
  request.id,
  request.customer_profile_id,
  revision.state,
  revision.revision,
  request.created_at,
  revision.changed_at,
  revision.activated_at
FROM job_requests request
JOIN job_request_revisions revision ON revision.job_request_id = request.id
ORDER BY request.id, revision.revision DESC;

-- R3-004 replaces this fail-closed body with authoritative validation over
-- its revisioned request content. No client-authored readiness token exists.
CREATE FUNCTION job_request_missing_submission_requirements(uuid, integer)
RETURNS job_request_submission_requirement[]
LANGUAGE sql
STABLE
AS $$
  SELECT ARRAY[
    'PRIMARY_PROFESSION'::job_request_submission_requirement,
    'DESCRIPTION'::job_request_submission_requirement,
    'MUNICIPALITY'::job_request_submission_requirement
  ];
$$;

CREATE FUNCTION validate_job_request_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_id uuid;
  owner_state user_account_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO owner_id, owner_state
  FROM customer_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.customer_profile_id
  FOR UPDATE OF owner, profile;
  IF NOT FOUND OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active customer owner required for job request';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_requests_identity_guard
BEFORE INSERT ON job_requests
FOR EACH ROW EXECUTE FUNCTION validate_job_request_identity();

CREATE FUNCTION validate_job_request_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision job_request_revisions%ROWTYPE;
  owner_id uuid;
  owner_state user_account_state;
  request_customer_id uuid;
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
  ORDER BY revision DESC
  LIMIT 1
  FOR UPDATE;

  IF NEW.command_kind = 'CREATE_DRAFT' THEN
    IF current_revision.job_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'job request draft already initialized';
    END IF;
  ELSE
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
  IF NOT FOUND
     OR source.job_request_id <> NEW.job_request_id
     OR source.resulting_revision <> NEW.revision
     OR source.target_state <> NEW.state THEN
    RAISE EXCEPTION 'job request revision must exactly match its command';
  END IF;

  SELECT * INTO prior FROM job_request_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF source.command_kind = 'CREATE_DRAFT' THEN
    IF prior.job_request_id IS NOT NULL OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'initial job request revision is invalid';
    END IF;
  ELSIF prior.job_request_id IS NULL
        OR prior.revision <> source.expected_revision
        OR prior.state <> 'DRAFT' THEN
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

CREATE FUNCTION ensure_job_request_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_request_revisions revision
    WHERE revision.command_id = NEW.command_id
      AND revision.job_request_id = NEW.job_request_id
      AND revision.revision = NEW.resulting_revision
      AND revision.state = NEW.target_state
  ) THEN
    RAISE EXCEPTION 'job request command requires an exact revision effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER job_request_command_effect_required
AFTER INSERT ON job_request_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_job_request_command_effect();

CREATE FUNCTION ensure_job_request_identity_initialized()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_request_revisions revision
    WHERE revision.job_request_id = NEW.id
      AND revision.revision = 1
      AND revision.state = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'job request identity requires an initial draft revision';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER job_request_identity_initial_revision_required
AFTER INSERT ON job_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_job_request_identity_initialized();

CREATE FUNCTION reject_job_request_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'job request history is append-only';
END;
$$;

CREATE TRIGGER job_requests_append_only
BEFORE UPDATE OR DELETE ON job_requests
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();
CREATE TRIGGER job_request_commands_append_only
BEFORE UPDATE OR DELETE ON job_request_commands
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();
CREATE TRIGGER job_request_revisions_append_only
BEFORE UPDATE OR DELETE ON job_request_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();
COMMENT ON TABLE job_requests IS
  'Private customer-owned JobRequest identity; current state is derived from immutable revisions.';
COMMENT ON FUNCTION job_request_missing_submission_requirements(uuid, integer) IS
  'Fail-closed server-owned R3-004 seam; activation never accepts client readiness.';
