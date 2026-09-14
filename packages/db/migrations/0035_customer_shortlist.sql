CREATE TYPE customer_shortlist_state AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE customer_shortlist_command_kind AS ENUM ('ADD', 'REMOVE');
CREATE TYPE customer_shortlist_command_result AS ENUM ('APPLIED', 'UNCHANGED');

CREATE TABLE customer_shortlist_commands (
  command_id uuid PRIMARY KEY,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_kind customer_shortlist_command_kind NOT NULL,
  expected_revision integer NOT NULL,
  result_kind customer_shortlist_command_result NOT NULL,
  resulting_revision integer NOT NULL,
  target_state customer_shortlist_state NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT customer_shortlist_commands_revisions_valid CHECK (
    expected_revision >= 0 AND resulting_revision >= 0
  ),
  CONSTRAINT customer_shortlist_commands_kind_state_consistent CHECK (
    (command_kind = 'ADD' AND target_state = 'ACTIVE')
    OR (command_kind = 'REMOVE' AND target_state = 'REMOVED')
  ),
  CONSTRAINT customer_shortlist_commands_fingerprint_sha256 CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX customer_shortlist_commands_customer_history_idx
  ON customer_shortlist_commands (
    customer_profile_id, created_at DESC, command_id
  );
CREATE INDEX customer_shortlist_commands_craftsman_reference_idx
  ON customer_shortlist_commands (craftsman_profile_id);

CREATE TABLE customer_shortlist_effects (
  command_id uuid PRIMARY KEY
    REFERENCES customer_shortlist_commands(command_id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  state customer_shortlist_state NOT NULL,
  changed_at timestamptz NOT NULL,
  CONSTRAINT customer_shortlist_effects_pair_revision_key UNIQUE (
    customer_profile_id, craftsman_profile_id, revision
  ),
  CONSTRAINT customer_shortlist_effects_revision_positive CHECK (revision > 0)
);

CREATE INDEX customer_shortlist_effects_craftsman_reference_idx
  ON customer_shortlist_effects (craftsman_profile_id);

CREATE TABLE customer_shortlist_entries (
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  state customer_shortlist_state NOT NULL,
  revision integer NOT NULL,
  latest_command_id uuid NOT NULL UNIQUE
    REFERENCES customer_shortlist_effects(command_id) ON DELETE RESTRICT,
  active_since timestamptz,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (customer_profile_id, craftsman_profile_id),
  CONSTRAINT customer_shortlist_entries_revision_positive CHECK (revision > 0),
  CONSTRAINT customer_shortlist_entries_active_since_consistent CHECK (
    (state = 'ACTIVE' AND active_since = changed_at)
    OR (state = 'REMOVED' AND active_since IS NULL)
  )
);

CREATE INDEX customer_shortlist_entries_owner_active_idx
  ON customer_shortlist_entries (
    customer_profile_id, changed_at DESC, craftsman_profile_id
  ) WHERE state = 'ACTIVE';
CREATE INDEX customer_shortlist_entries_craftsman_reference_idx
  ON customer_shortlist_entries (craftsman_profile_id);

CREATE FUNCTION validate_customer_shortlist_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_entry customer_shortlist_entries%ROWTYPE;
  owner_id uuid;
  owner_state user_account_state;
  target_owner_id uuid;
BEGIN
  SELECT owner_user_id INTO target_owner_id
  FROM craftsman_profiles
  WHERE id = NEW.craftsman_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'craftsman profile required for shortlist command';
  END IF;

  -- Publication commands lock the profile before its owner. Reciprocal
  -- shortlist operations then lock both user rows in UUID order.
  PERFORM id FROM craftsman_profiles
  WHERE id = NEW.craftsman_profile_id
  FOR UPDATE;
  PERFORM id FROM users
  WHERE id IN (NEW.actor_user_id, target_owner_id)
  ORDER BY id
  FOR UPDATE;

  SELECT profile.owner_user_id, owner.account_state
    INTO owner_id, owner_state
  FROM customer_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.customer_profile_id
  FOR UPDATE OF profile;

  IF NOT FOUND OR owner_id <> NEW.actor_user_id OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active owning customer required for shortlist command';
  END IF;

  IF NEW.command_kind = 'ADD' AND NOT EXISTS (
    SELECT 1 FROM current_searchable_craftsman_profiles searchable
    WHERE searchable.craftsman_profile_id = NEW.craftsman_profile_id
  ) THEN
    RAISE EXCEPTION 'public approved active craftsman required for shortlist add';
  END IF;

  SELECT * INTO current_entry
  FROM customer_shortlist_entries entry
  WHERE entry.customer_profile_id = NEW.customer_profile_id
    AND entry.craftsman_profile_id = NEW.craftsman_profile_id
  FOR UPDATE;

  IF NEW.expected_revision <> COALESCE(current_entry.revision, 0) THEN
    RAISE EXCEPTION 'customer shortlist command has stale revision';
  END IF;

  IF current_entry.customer_profile_id IS NOT NULL
     AND current_entry.state = NEW.target_state THEN
    IF NEW.result_kind <> 'UNCHANGED'
       OR NEW.resulting_revision <> current_entry.revision THEN
      RAISE EXCEPTION 'unchanged shortlist command shape is invalid';
    END IF;
  ELSIF current_entry.customer_profile_id IS NULL
        AND NEW.command_kind = 'REMOVE' THEN
    IF NEW.result_kind <> 'UNCHANGED' OR NEW.resulting_revision <> 0 THEN
      RAISE EXCEPTION 'absent shortlist removal shape is invalid';
    END IF;
  ELSE
    IF NEW.result_kind <> 'APPLIED'
       OR NEW.resulting_revision <> COALESCE(current_entry.revision, 0) + 1 THEN
      RAISE EXCEPTION 'applied shortlist command shape is invalid';
    END IF;
  END IF;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_shortlist_commands_insert_guard
BEFORE INSERT ON customer_shortlist_commands
FOR EACH ROW EXECUTE FUNCTION validate_customer_shortlist_command();

CREATE FUNCTION validate_customer_shortlist_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE source customer_shortlist_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM customer_shortlist_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.result_kind <> 'APPLIED'
     OR source.customer_profile_id <> NEW.customer_profile_id
     OR source.craftsman_profile_id <> NEW.craftsman_profile_id
     OR source.resulting_revision <> NEW.revision
     OR source.target_state <> NEW.state THEN
    RAISE EXCEPTION 'shortlist effect must exactly match applied command';
  END IF;
  NEW.changed_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_shortlist_effects_insert_guard
BEFORE INSERT ON customer_shortlist_effects
FOR EACH ROW EXECUTE FUNCTION validate_customer_shortlist_effect();

CREATE FUNCTION validate_customer_shortlist_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE effect customer_shortlist_effects%ROWTYPE;
BEGIN
  SELECT * INTO effect FROM customer_shortlist_effects
  WHERE command_id = NEW.latest_command_id FOR UPDATE;
  IF NOT FOUND OR effect.customer_profile_id <> NEW.customer_profile_id
     OR effect.craftsman_profile_id <> NEW.craftsman_profile_id
     OR effect.revision <> NEW.revision OR effect.state <> NEW.state
     OR effect.changed_at <> NEW.changed_at THEN
    RAISE EXCEPTION 'shortlist head must exactly match its effect';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'initial shortlist revision must be one';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.customer_profile_id <> OLD.customer_profile_id
    OR NEW.craftsman_profile_id <> OLD.craftsman_profile_id
    OR NEW.revision <> OLD.revision + 1
  ) THEN
    RAISE EXCEPTION 'shortlist head transition is invalid';
  END IF;
  NEW.active_since := CASE WHEN NEW.state = 'ACTIVE' THEN effect.changed_at ELSE NULL END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_shortlist_entries_write_guard
BEFORE INSERT OR UPDATE ON customer_shortlist_entries
FOR EACH ROW EXECUTE FUNCTION validate_customer_shortlist_entry();

CREATE FUNCTION ensure_customer_shortlist_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.result_kind = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM customer_shortlist_effects effect
    JOIN customer_shortlist_entries entry
      ON entry.latest_command_id = effect.command_id
    WHERE effect.command_id = NEW.command_id
      AND entry.customer_profile_id = NEW.customer_profile_id
      AND entry.craftsman_profile_id = NEW.craftsman_profile_id
      AND entry.revision = NEW.resulting_revision
      AND entry.state = NEW.target_state
  ) THEN
    RAISE EXCEPTION 'applied shortlist command requires a current effect';
  END IF;
  IF NEW.result_kind = 'UNCHANGED' AND EXISTS (
    SELECT 1 FROM customer_shortlist_effects WHERE command_id = NEW.command_id
  ) THEN
    RAISE EXCEPTION 'unchanged shortlist command cannot create an effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER customer_shortlist_command_effect_required
AFTER INSERT ON customer_shortlist_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_customer_shortlist_command_effect();

CREATE FUNCTION reject_customer_shortlist_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer shortlist command/effect history is append-only';
END;
$$;

CREATE TRIGGER customer_shortlist_commands_append_only
BEFORE UPDATE OR DELETE ON customer_shortlist_commands
FOR EACH ROW EXECUTE FUNCTION reject_customer_shortlist_history_mutation();
CREATE TRIGGER customer_shortlist_effects_append_only
BEFORE UPDATE OR DELETE ON customer_shortlist_effects
FOR EACH ROW EXECUTE FUNCTION reject_customer_shortlist_history_mutation();
CREATE TRIGGER customer_shortlist_entries_no_delete
BEFORE DELETE ON customer_shortlist_entries
FOR EACH ROW EXECUTE FUNCTION reject_customer_shortlist_history_mutation();

COMMENT ON TABLE customer_shortlist_entries IS
  'Private owner-scoped current shortlist membership. Five is an invitation limit, never a shortlist limit.';
COMMENT ON TABLE customer_shortlist_commands IS
  'Bounded immutable shortlist command provenance; no query, card, rank, contact, address or profile snapshot.';
