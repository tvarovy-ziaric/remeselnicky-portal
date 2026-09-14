CREATE TYPE craftsman_availability_state AS ENUM (
  'AVAILABLE',
  'BUSY',
  'UNAVAILABLE'
);
CREATE TYPE craftsman_availability_block_state AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE craftsman_availability_command_kind AS ENUM ('ADD', 'REPLACE', 'ARCHIVE');
CREATE TYPE craftsman_availability_command_result AS ENUM ('APPLIED', 'UNCHANGED');

CREATE TABLE craftsman_availability_commands (
  command_id uuid PRIMARY KEY,
  command_kind craftsman_availability_command_kind NOT NULL,
  block_id uuid NOT NULL,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL,
  result_kind craftsman_availability_command_result NOT NULL,
  resulting_revision integer NOT NULL,
  target_state craftsman_availability_block_state NOT NULL,
  availability craftsman_availability_state NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT craftsman_availability_commands_expected_revision_nonnegative
    CHECK (expected_revision >= 0),
  CONSTRAINT craftsman_availability_commands_resulting_revision_positive
    CHECK (resulting_revision > 0),
  CONSTRAINT craftsman_availability_commands_range_safe CHECK (
    isfinite(starts_at)
    AND isfinite(ends_at)
    AND starts_at >= timestamptz '2000-01-01 00:00:00+00'
    AND ends_at <= timestamptz '2200-01-01 00:00:00+00'
    AND starts_at < ends_at
    AND ends_at - starts_at <= interval '3660 days'
  ),
  CONSTRAINT craftsman_availability_commands_fingerprint_sha256
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX craftsman_availability_commands_block_created_idx
  ON craftsman_availability_commands (block_id, created_at DESC);
CREATE INDEX craftsman_availability_commands_profile_created_idx
  ON craftsman_availability_commands (craftsman_profile_id, created_at DESC);

CREATE TABLE craftsman_availability_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE
    REFERENCES craftsman_availability_commands(command_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  state craftsman_availability_block_state NOT NULL,
  availability craftsman_availability_state NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT craftsman_availability_revisions_block_revision_key
    UNIQUE (block_id, revision),
  CONSTRAINT craftsman_availability_revisions_revision_positive
    CHECK (revision > 0),
  CONSTRAINT craftsman_availability_revisions_range_safe CHECK (
    isfinite(starts_at)
    AND isfinite(ends_at)
    AND starts_at >= timestamptz '2000-01-01 00:00:00+00'
    AND ends_at <= timestamptz '2200-01-01 00:00:00+00'
    AND starts_at < ends_at
    AND ends_at - starts_at <= interval '3660 days'
  ),
  CONSTRAINT craftsman_availability_revisions_archive_consistent CHECK (
    (state = 'ACTIVE' AND archived_at IS NULL)
    OR (state = 'ARCHIVED' AND archived_at = changed_at)
  )
);

CREATE INDEX craftsman_availability_revisions_profile_range_idx
  ON craftsman_availability_revisions (
    craftsman_profile_id,
    starts_at,
    ends_at
  );

CREATE FUNCTION validate_craftsman_availability_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_id uuid;
  owner_state user_account_state;
  current craftsman_availability_revisions%ROWTYPE;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF NOT FOUND OR owner_id IS DISTINCT FROM NEW.actor_user_id OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active owned craftsman profile required for availability command';
  END IF;

  SELECT revision.* INTO current
  FROM craftsman_availability_revisions revision
  WHERE revision.block_id = NEW.block_id
  ORDER BY revision.revision DESC
  LIMIT 1;

  CASE NEW.command_kind
    WHEN 'ADD' THEN
      IF current.id IS NOT NULL THEN
        RAISE EXCEPTION 'availability block identity already exists';
      END IF;
      IF NEW.expected_revision <> 0
         OR NEW.result_kind <> 'APPLIED'
         OR NEW.target_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'availability ADD command shape is invalid';
      END IF;
      NEW.resulting_revision := 1;
    WHEN 'REPLACE' THEN
      IF current.id IS NULL OR current.craftsman_profile_id <> NEW.craftsman_profile_id
         OR current.state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'active owned availability block required';
      END IF;
      IF NEW.expected_revision <> current.revision THEN
        RAISE EXCEPTION 'availability command has stale revision';
      END IF;
      IF NEW.target_state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'availability REPLACE command cannot change lifecycle';
      END IF;
      IF current.availability = NEW.availability
         AND current.starts_at = NEW.starts_at
         AND current.ends_at = NEW.ends_at THEN
        IF NEW.result_kind <> 'UNCHANGED' THEN
          RAISE EXCEPTION 'unchanged availability command must be recorded as unchanged';
        END IF;
        NEW.resulting_revision := current.revision;
      ELSE
        IF NEW.result_kind <> 'APPLIED' THEN
          RAISE EXCEPTION 'changed availability command requires revision effect';
        END IF;
        NEW.resulting_revision := current.revision + 1;
      END IF;
    WHEN 'ARCHIVE' THEN
      IF current.id IS NULL OR current.craftsman_profile_id <> NEW.craftsman_profile_id
         OR current.state <> 'ACTIVE' THEN
        RAISE EXCEPTION 'active owned availability block required';
      END IF;
      IF NEW.expected_revision <> current.revision THEN
        RAISE EXCEPTION 'availability command has stale revision';
      END IF;
      IF NEW.result_kind <> 'APPLIED' OR NEW.target_state <> 'ARCHIVED'
         OR NEW.availability <> current.availability
         OR NEW.starts_at <> current.starts_at
         OR NEW.ends_at <> current.ends_at THEN
        RAISE EXCEPTION 'availability ARCHIVE must preserve marked interval';
      END IF;
      NEW.resulting_revision := current.revision + 1;
  END CASE;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_availability_commands_insert_guard
BEFORE INSERT ON craftsman_availability_commands
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_availability_command();

CREATE FUNCTION validate_craftsman_availability_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source craftsman_availability_commands%ROWTYPE;
BEGIN
  SELECT * INTO source
  FROM craftsman_availability_commands
  WHERE command_id = NEW.command_id
  FOR UPDATE;

  IF NOT FOUND OR source.result_kind <> 'APPLIED'
     OR source.block_id <> NEW.block_id
     OR source.craftsman_profile_id <> NEW.craftsman_profile_id
     OR source.target_state <> NEW.state
     OR source.availability <> NEW.availability
     OR source.starts_at <> NEW.starts_at
     OR source.ends_at <> NEW.ends_at THEN
    RAISE EXCEPTION 'availability revision must exactly match applied command provenance';
  END IF;

  NEW.revision := source.resulting_revision;
  NEW.changed_at := source.created_at;
  NEW.archived_at := CASE WHEN source.target_state = 'ARCHIVED'
    THEN source.created_at ELSE NULL END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_availability_revisions_insert_guard
BEFORE INSERT ON craftsman_availability_revisions
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_availability_revision();

CREATE FUNCTION ensure_craftsman_availability_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source craftsman_availability_commands%ROWTYPE;
  effect craftsman_availability_revisions%ROWTYPE;
BEGIN
  SELECT * INTO source
  FROM craftsman_availability_commands
  WHERE command_id = COALESCE(NEW.command_id, OLD.command_id);
  SELECT * INTO effect
  FROM craftsman_availability_revisions
  WHERE command_id = source.command_id;

  IF source.result_kind = 'APPLIED' AND effect.id IS NULL THEN
    RAISE EXCEPTION 'applied availability command requires exact revision effect';
  END IF;
  IF source.result_kind = 'UNCHANGED' AND effect.id IS NOT NULL THEN
    RAISE EXCEPTION 'unchanged availability command cannot create revision effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER craftsman_availability_command_effect_required
AFTER INSERT ON craftsman_availability_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_availability_command_effect();

CREATE FUNCTION reject_craftsman_availability_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'craftsman availability history is append-only';
END;
$$;

CREATE TRIGGER craftsman_availability_commands_append_only
BEFORE UPDATE OR DELETE ON craftsman_availability_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_availability_history_mutation();
CREATE TRIGGER craftsman_availability_revisions_append_only
BEFORE UPDATE OR DELETE ON craftsman_availability_revisions
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_availability_history_mutation();

CREATE VIEW current_craftsman_availability_blocks AS
SELECT DISTINCT ON (revision.block_id)
  revision.id,
  revision.block_id,
  revision.craftsman_profile_id,
  revision.revision,
  revision.state,
  revision.availability,
  revision.starts_at,
  revision.ends_at,
  revision.changed_at,
  revision.archived_at,
  first_value(revision.changed_at) OVER (
    PARTITION BY revision.block_id ORDER BY revision.revision
  ) AS created_at
FROM craftsman_availability_revisions revision
ORDER BY revision.block_id, revision.revision DESC;

COMMENT ON TABLE craftsman_availability_revisions IS
  'Private explicit availability markings. Overlaps have no automatic precedence, merge, booking, capacity or contractual meaning.';
COMMENT ON VIEW current_craftsman_availability_blocks IS
  'Private owner projection only; precise calendar periods require a later privacy-reviewed public projection.';
