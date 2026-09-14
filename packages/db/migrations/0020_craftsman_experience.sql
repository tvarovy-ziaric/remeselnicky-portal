CREATE TYPE craftsman_experience_command_result AS ENUM (
  'APPLIED',
  'UNCHANGED'
);

CREATE TABLE craftsman_experience_commands (
  command_id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL,
  result_kind craftsman_experience_command_result NOT NULL,
  resulting_revision integer NOT NULL,
  working_since_year integer,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT craftsman_experience_expected_revision_nonnegative CHECK (
    expected_revision >= 0
  ),
  CONSTRAINT craftsman_experience_resulting_revision_nonnegative CHECK (
    resulting_revision >= 0
  ),
  CONSTRAINT craftsman_experience_result_revision_consistent CHECK (
    (result_kind = 'APPLIED' AND resulting_revision = expected_revision + 1)
    OR (result_kind = 'UNCHANGED' AND resulting_revision = expected_revision)
  ),
  CONSTRAINT craftsman_experience_working_since_technical_range CHECK (
    working_since_year IS NULL OR working_since_year BETWEEN 1800 AND 9999
  ),
  CONSTRAINT craftsman_experience_fingerprint_sha256 CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX craftsman_experience_commands_profile_created_idx
ON craftsman_experience_commands (
  craftsman_profile_id,
  created_at,
  command_id
);

CREATE TABLE craftsman_experience_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE
    REFERENCES craftsman_experience_commands(command_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  working_since_year integer,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT craftsman_experience_revisions_profile_revision_key UNIQUE (
    craftsman_profile_id,
    revision
  ),
  CONSTRAINT craftsman_experience_revision_positive CHECK (revision > 0),
  CONSTRAINT craftsman_experience_revision_year_technical_range CHECK (
    working_since_year IS NULL OR working_since_year BETWEEN 1800 AND 9999
  )
);

CREATE FUNCTION validate_craftsman_experience_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_owner_id uuid;
  owner_state user_account_state;
  current_revision integer;
  current_working_since_year integer;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF profile_owner_id IS DISTINCT FROM NEW.actor_user_id
    OR owner_state IS DISTINCT FROM 'ACTIVE'
  THEN
    RAISE EXCEPTION 'active owned craftsman profile required for experience command';
  END IF;

  SELECT revision, working_since_year
  INTO current_revision, current_working_since_year
  FROM craftsman_experience_revisions history
  WHERE history.craftsman_profile_id = NEW.craftsman_profile_id
  ORDER BY revision DESC
  LIMIT 1;
  current_revision := COALESCE(current_revision, 0);

  IF NEW.expected_revision <> current_revision THEN
    RAISE EXCEPTION 'craftsman experience command has stale revision';
  END IF;
  IF NEW.working_since_year IS NOT NULL
    AND (
      NEW.working_since_year < 1800
      OR NEW.working_since_year > EXTRACT(YEAR FROM CURRENT_DATE)::integer
    )
  THEN
    RAISE EXCEPTION 'working-since year cannot be outside the server calendar range';
  END IF;

  IF NEW.working_since_year IS NOT DISTINCT FROM current_working_since_year THEN
    NEW.result_kind := 'UNCHANGED';
    NEW.resulting_revision := current_revision;
  ELSE
    NEW.result_kind := 'APPLIED';
    NEW.resulting_revision := current_revision + 1;
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_experience_commands_insert_guard
BEFORE INSERT ON craftsman_experience_commands
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_experience_command();

CREATE FUNCTION validate_craftsman_experience_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source craftsman_experience_commands%ROWTYPE;
BEGIN
  SELECT * INTO source
  FROM craftsman_experience_commands command
  WHERE command.command_id = NEW.command_id
  FOR UPDATE;

  IF NOT FOUND
    OR source.result_kind <> 'APPLIED'
    OR source.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR source.resulting_revision IS DISTINCT FROM NEW.revision
    OR source.working_since_year IS DISTINCT FROM NEW.working_since_year
  THEN
    RAISE EXCEPTION 'craftsman experience revision must match applied command provenance';
  END IF;

  NEW.created_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_experience_revisions_insert_guard
BEFORE INSERT ON craftsman_experience_revisions
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_experience_revision();

CREATE FUNCTION ensure_craftsman_experience_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect craftsman_experience_revisions%ROWTYPE;
  current_revision integer;
  current_working_since_year integer;
BEGIN
  SELECT * INTO effect
  FROM craftsman_experience_revisions history
  WHERE history.command_id = NEW.command_id;

  SELECT revision, working_since_year
  INTO current_revision, current_working_since_year
  FROM craftsman_experience_revisions history
  WHERE history.craftsman_profile_id = NEW.craftsman_profile_id
  ORDER BY revision DESC
  LIMIT 1;
  current_revision := COALESCE(current_revision, 0);

  IF NEW.result_kind = 'APPLIED' AND (
    effect.command_id IS NULL
    OR effect.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR effect.revision IS DISTINCT FROM NEW.resulting_revision
    OR effect.working_since_year IS DISTINCT FROM NEW.working_since_year
  ) THEN
    RAISE EXCEPTION 'applied craftsman experience command requires exact revision effect';
  END IF;
  IF NEW.result_kind = 'UNCHANGED' AND effect.command_id IS NOT NULL THEN
    RAISE EXCEPTION 'unchanged craftsman experience command cannot create a revision effect';
  END IF;
  IF current_revision IS DISTINCT FROM NEW.resulting_revision
    OR current_working_since_year IS DISTINCT FROM NEW.working_since_year
  THEN
    RAISE EXCEPTION 'craftsman experience command must describe the current profile-wide state';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER craftsman_experience_command_effect_required
AFTER INSERT ON craftsman_experience_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_experience_command_effect();

CREATE FUNCTION reject_craftsman_experience_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'craftsman experience history is append-only';
END;
$$;

CREATE TRIGGER craftsman_experience_commands_append_only
BEFORE UPDATE OR DELETE ON craftsman_experience_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_experience_history_mutation();
CREATE TRIGGER craftsman_experience_revisions_append_only
BEFORE UPDATE OR DELETE ON craftsman_experience_revisions
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_experience_history_mutation();

CREATE VIEW current_craftsman_experience AS
SELECT DISTINCT ON (history.craftsman_profile_id)
  history.id,
  history.craftsman_profile_id,
  history.revision,
  history.working_since_year,
  history.created_at
FROM craftsman_experience_revisions history
ORDER BY history.craftsman_profile_id, history.revision DESC;

COMMENT ON TABLE craftsman_experience_revisions IS
  'Optional profile-wide self-declared working-since context; not evidence-supported proficiency, reputation, or maintained years-of-experience.';
