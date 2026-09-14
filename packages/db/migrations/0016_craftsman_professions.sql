CREATE TYPE profession_proficiency_level AS ENUM (
  'BEGINNER',
  'ADVANCED',
  'MASTER'
);
CREATE TYPE craftsman_profession_state AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE craftsman_profession_command_kind AS ENUM (
  'ASSIGN',
  'CHANGE_DECLARED_LEVEL',
  'DEACTIVATE'
);

CREATE TABLE craftsman_professions (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  taxonomy_release_id uuid NOT NULL,
  profession_code text NOT NULL,
  state craftsman_profession_state NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deactivated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at timestamptz,
  FOREIGN KEY (taxonomy_release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code)
    ON DELETE RESTRICT,
  CONSTRAINT craftsman_profession_state_consistent CHECK (
    (
      state = 'ACTIVE'
      AND deactivated_by_user_id IS NULL
      AND deactivation_command_id IS NULL
      AND deactivated_at IS NULL
    )
    OR (
      state = 'INACTIVE'
      AND deactivated_by_user_id IS NOT NULL
      AND deactivation_command_id IS NOT NULL
      AND deactivated_at IS NOT NULL
      AND deactivated_at >= created_at
    )
  )
);

CREATE UNIQUE INDEX craftsman_professions_one_active_code_per_profile
ON craftsman_professions (craftsman_profile_id, profession_code)
WHERE state = 'ACTIVE';

CREATE INDEX craftsman_professions_profile_history_idx
ON craftsman_professions (craftsman_profile_id, created_at, id);

CREATE TABLE craftsman_profession_commands (
  command_id uuid PRIMARY KEY,
  command_kind craftsman_profession_command_kind NOT NULL,
  craftsman_profession_id uuid NOT NULL
    REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_fingerprint char(64) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT craftsman_profession_command_fingerprint_safe CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX craftsman_profession_commands_assignment_idx
ON craftsman_profession_commands (craftsman_profession_id, occurred_at);

CREATE UNIQUE INDEX craftsman_profession_commands_one_assign
ON craftsman_profession_commands (craftsman_profession_id)
WHERE command_kind = 'ASSIGN';

CREATE UNIQUE INDEX craftsman_profession_commands_one_deactivation
ON craftsman_profession_commands (craftsman_profession_id)
WHERE command_kind = 'DEACTIVATE';

ALTER TABLE craftsman_professions
ADD CONSTRAINT craftsman_professions_deactivation_command_fkey
FOREIGN KEY (deactivation_command_id)
REFERENCES craftsman_profession_commands(command_id) ON DELETE RESTRICT;

CREATE TABLE craftsman_profession_declared_level_events (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE
    REFERENCES craftsman_profession_commands(command_id) ON DELETE RESTRICT,
  craftsman_profession_id uuid NOT NULL
    REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  declared_level profession_proficiency_level NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (craftsman_profession_id, revision)
);

CREATE FUNCTION enforce_craftsman_profession_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_owner_id uuid;
  owner_state user_account_state;
  current_release_id uuid;
  taxonomy_state taxonomy_entry_state;
BEGIN
  NEW.created_at := clock_timestamp();
  IF NEW.state <> 'ACTIVE'
    OR NEW.deactivated_by_user_id IS NOT NULL
    OR NEW.deactivation_command_id IS NOT NULL
    OR NEW.deactivated_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'craftsman profession must start ACTIVE';
  END IF;

  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF profile_owner_id IS NULL THEN
    RAISE EXCEPTION 'craftsman profile is unavailable';
  END IF;
  IF profile_owner_id IS DISTINCT FROM NEW.created_by_user_id
    OR owner_state <> 'ACTIVE'
  THEN
    RAISE EXCEPTION 'active craftsman profile owner required';
  END IF;

  SELECT release_id INTO current_release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1;
  IF current_release_id IS DISTINCT FROM NEW.taxonomy_release_id THEN
    RAISE EXCEPTION 'stale profession taxonomy release';
  END IF;

  SELECT profession.state INTO taxonomy_state
  FROM taxonomy_professions profession
  JOIN profession_taxonomy_releases release
    ON release.release_id = profession.release_id
  WHERE profession.release_id = NEW.taxonomy_release_id
    AND profession.profession_code = NEW.profession_code
    AND release.content_class = 'CANONICAL'
    AND release.review_state = 'HUMAN_REVIEW_APPROVED';
  IF taxonomy_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'profession must be active in current canonical taxonomy';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profession_insert_guard
BEFORE INSERT ON craftsman_professions
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_profession_insert();

CREATE FUNCTION enforce_craftsman_profession_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_owner_id uuid;
  owner_state user_account_state;
  deactivation_command craftsman_profession_commands%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.taxonomy_release_id IS DISTINCT FROM OLD.taxonomy_release_id
    OR NEW.profession_code IS DISTINCT FROM OLD.profession_code
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'craftsman profession identity and provenance are immutable';
  END IF;
  IF OLD.state <> 'ACTIVE' OR NEW.state <> 'INACTIVE' THEN
    RAISE EXCEPTION 'invalid craftsman profession transition';
  END IF;

  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = OLD.craftsman_profile_id
  FOR UPDATE OF profile, owner;
  IF profile_owner_id IS NULL
    OR profile_owner_id IS DISTINCT FROM NEW.deactivated_by_user_id
    OR owner_state <> 'ACTIVE'
  THEN
    RAISE EXCEPTION 'active craftsman profile owner required';
  END IF;
  SELECT * INTO deactivation_command
  FROM craftsman_profession_commands
  WHERE command_id = NEW.deactivation_command_id;
  IF deactivation_command.command_id IS NULL
    OR deactivation_command.command_kind <> 'DEACTIVATE'
    OR deactivation_command.craftsman_profession_id IS DISTINCT FROM OLD.id
    OR deactivation_command.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR deactivation_command.actor_user_id IS DISTINCT FROM NEW.deactivated_by_user_id
  THEN
    RAISE EXCEPTION 'deactivation requires matching command provenance';
  END IF;
  NEW.deactivated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profession_update_guard
BEFORE UPDATE ON craftsman_professions
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_profession_update();

CREATE FUNCTION enforce_craftsman_profession_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  assignment_profile_id uuid;
  assignment_state craftsman_profession_state;
  profile_owner_id uuid;
  owner_state user_account_state;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT assignment.craftsman_profile_id, assignment.state
  INTO assignment_profile_id, assignment_state
  FROM craftsman_professions assignment
  WHERE assignment.id = NEW.craftsman_profession_id
  FOR UPDATE;
  IF assignment_profile_id IS NULL
    OR assignment_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
  THEN
    RAISE EXCEPTION 'craftsman profession command target mismatch';
  END IF;

  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;
  IF profile_owner_id IS NULL
    OR profile_owner_id IS DISTINCT FROM NEW.actor_user_id
    OR owner_state <> 'ACTIVE'
  THEN
    RAISE EXCEPTION 'active craftsman profile owner required';
  END IF;
  IF assignment_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'craftsman profession is not active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profession_command_guard
BEFORE INSERT ON craftsman_profession_commands
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_profession_command();

CREATE FUNCTION enforce_declared_level_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_record craftsman_profession_commands%ROWTYPE;
  current_revision integer;
  current_level profession_proficiency_level;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO command_record
  FROM craftsman_profession_commands
  WHERE command_id = NEW.command_id;
  IF command_record.command_id IS NULL
    OR command_record.craftsman_profession_id IS DISTINCT FROM NEW.craftsman_profession_id
    OR command_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR command_record.command_kind NOT IN ('ASSIGN', 'CHANGE_DECLARED_LEVEL')
  THEN
    RAISE EXCEPTION 'declared level event command mismatch';
  END IF;

  PERFORM 1
  FROM craftsman_professions
  WHERE id = NEW.craftsman_profession_id AND state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'craftsman profession is not active';
  END IF;

  SELECT revision, declared_level
  INTO current_revision, current_level
  FROM craftsman_profession_declared_level_events
  WHERE craftsman_profession_id = NEW.craftsman_profession_id
  ORDER BY revision DESC
  LIMIT 1;

  IF current_revision IS NULL THEN
    IF NEW.revision <> 1 OR command_record.command_kind <> 'ASSIGN' THEN
      RAISE EXCEPTION 'first declared proficiency revision must be ASSIGN revision 1';
    END IF;
  ELSIF NEW.revision <> current_revision + 1
    OR command_record.command_kind <> 'CHANGE_DECLARED_LEVEL'
  THEN
    RAISE EXCEPTION 'declared proficiency revisions must be contiguous';
  ELSIF NEW.declared_level = current_level THEN
    RAISE EXCEPTION 'declared proficiency level must change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profession_declared_level_guard
BEFORE INSERT ON craftsman_profession_declared_level_events
FOR EACH ROW EXECUTE FUNCTION enforce_declared_level_event();

CREATE FUNCTION ensure_craftsman_profession_initial_level()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM craftsman_profession_declared_level_events event
    JOIN craftsman_profession_commands command
      ON command.command_id = event.command_id
    WHERE event.craftsman_profession_id = NEW.id
      AND event.revision = 1
      AND command.command_kind = 'ASSIGN'
  ) THEN
    RAISE EXCEPTION 'craftsman profession requires initial declared proficiency';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER craftsman_profession_initial_level_required
AFTER INSERT ON craftsman_professions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_profession_initial_level();

CREATE FUNCTION ensure_craftsman_profession_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_kind IN ('ASSIGN', 'CHANGE_DECLARED_LEVEL') AND NOT EXISTS (
    SELECT 1
    FROM craftsman_profession_declared_level_events event
    WHERE event.command_id = NEW.command_id
  ) THEN
    RAISE EXCEPTION 'declared proficiency command requires an event';
  ELSIF NEW.command_kind = 'DEACTIVATE' AND NOT EXISTS (
    SELECT 1
    FROM craftsman_professions assignment
    WHERE assignment.id = NEW.craftsman_profession_id
      AND assignment.state = 'INACTIVE'
      AND assignment.deactivation_command_id = NEW.command_id
  ) THEN
    RAISE EXCEPTION 'deactivation command requires an inactive assignment';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER craftsman_profession_command_effect_required
AFTER INSERT ON craftsman_profession_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_profession_command_effect();

CREATE FUNCTION reject_craftsman_profession_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'craftsman profession history is append-only';
END;
$$;

CREATE TRIGGER craftsman_profession_no_delete
BEFORE DELETE ON craftsman_professions
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_profession_history_mutation();
CREATE TRIGGER craftsman_profession_commands_immutable
BEFORE UPDATE OR DELETE ON craftsman_profession_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_profession_history_mutation();
CREATE TRIGGER craftsman_profession_declared_levels_immutable
BEFORE UPDATE OR DELETE ON craftsman_profession_declared_level_events
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_profession_history_mutation();

CREATE VIEW current_craftsman_professions AS
SELECT
  assignment.id,
  assignment.craftsman_profile_id,
  assignment.taxonomy_release_id,
  assignment.profession_code,
  assignment.state,
  declared.declared_level,
  declared.revision AS declared_level_revision,
  declared.occurred_at AS declared_level_changed_at,
  NULL::profession_proficiency_level AS evidence_supported_level,
  NULL::timestamptz AS evidence_supported_at,
  assignment.created_at,
  assignment.deactivated_at
FROM craftsman_professions assignment
JOIN LATERAL (
  SELECT event.declared_level, event.revision, event.occurred_at
  FROM craftsman_profession_declared_level_events event
  WHERE event.craftsman_profession_id = assignment.id
  ORDER BY event.revision DESC
  LIMIT 1
) declared ON true;

COMMENT ON VIEW current_craftsman_professions IS
  'Current declared proficiency with a deliberately separate nullable evidence-supported projection. R1-004 exposes no owner write path for evidence support.';
