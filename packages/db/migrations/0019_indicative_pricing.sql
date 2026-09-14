CREATE TYPE indicative_price_mode AS ENUM (
  'FROM',
  'APPROXIMATE',
  'HOURLY',
  'PER_SQUARE_METER',
  'PER_UNIT',
  'OTHER'
);
CREATE TYPE indicative_pricing_entry_state AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE indicative_pricing_command_kind AS ENUM ('ADD', 'EDIT', 'ARCHIVE');

CREATE FUNCTION indicative_pricing_public_text_safe(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT
    value !~ '[[:cntrl:]]'
    AND value !~* '[[:alnum:]_.%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    AND value !~* '@[[:alnum:]_]{2,}'
    AND value !~* '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)'
    AND value !~* '\m(https?://|www\.)'
    AND value !~* '(^|[^[:alnum:]_-])[[:alnum:]][[:alnum:]-]{0,62}(\.[[:alnum:]-]{1,63})*\.[[:alpha:]]{2,24}([^[:alnum:]_-]|$)'
    AND value !~ '(^|[^0-9])[0-9]{3}[[:space:]]?[0-9]{2}([^0-9]|$)'
    AND value !~* '(\m(adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\M|\m(ul|nám)\.)'
    AND value !~* '\m(heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\M';
$$;

CREATE TABLE indicative_pricing_entries (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid
    REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  service_name text NOT NULL,
  price_mode indicative_price_mode NOT NULL,
  amount_cents bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'EUR',
  note text,
  state indicative_pricing_entry_state NOT NULL DEFAULT 'ACTIVE',
  revision integer NOT NULL DEFAULT 1,
  latest_command_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  archived_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at timestamptz,
  CONSTRAINT indicative_pricing_amount_positive_safe_integer CHECK (
    amount_cents BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT indicative_pricing_currency_eur_only CHECK (currency = 'EUR'),
  CONSTRAINT indicative_pricing_service_name_safe CHECK (
    service_name = btrim(service_name)
    AND length(service_name) BETWEEN 1 AND 160
    AND indicative_pricing_public_text_safe(service_name)
  ),
  CONSTRAINT indicative_pricing_note_safe CHECK (
    note IS NULL OR (
      note = btrim(note)
      AND length(note) BETWEEN 1 AND 500
      AND indicative_pricing_public_text_safe(note)
    )
  ),
  CONSTRAINT indicative_pricing_revision_positive CHECK (revision > 0),
  CONSTRAINT indicative_pricing_timestamps_ordered CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT indicative_pricing_state_consistent CHECK (
    (
      state = 'ACTIVE'
      AND archived_by_user_id IS NULL
      AND archived_at IS NULL
    ) OR (
      state = 'ARCHIVED'
      AND archived_by_user_id IS NOT NULL
      AND archived_at IS NOT NULL
      AND archived_at >= created_at
    )
  )
);

CREATE INDEX indicative_pricing_entries_profile_order_idx
ON indicative_pricing_entries (craftsman_profile_id, created_at, id);

CREATE INDEX indicative_pricing_entries_active_profile_order_idx
ON indicative_pricing_entries (craftsman_profile_id, created_at, id)
WHERE state = 'ACTIVE';

CREATE TABLE indicative_pricing_commands (
  command_id uuid PRIMARY KEY,
  command_kind indicative_pricing_command_kind NOT NULL,
  entry_id uuid NOT NULL
    REFERENCES indicative_pricing_entries(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_fingerprint char(64) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT indicative_pricing_command_fingerprint_safe CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX indicative_pricing_commands_entry_history_idx
ON indicative_pricing_commands (entry_id, occurred_at, command_id);

ALTER TABLE indicative_pricing_entries
ADD CONSTRAINT indicative_pricing_entries_latest_command_fkey
FOREIGN KEY (latest_command_id)
REFERENCES indicative_pricing_commands(command_id)
ON DELETE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE indicative_pricing_entry_revisions (
  entry_id uuid NOT NULL
    REFERENCES indicative_pricing_entries(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES indicative_pricing_commands(command_id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid
    REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  service_name text NOT NULL,
  price_mode indicative_price_mode NOT NULL,
  amount_cents bigint NOT NULL,
  currency char(3) NOT NULL,
  note text,
  state indicative_pricing_entry_state NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at timestamptz,
  PRIMARY KEY (entry_id, revision),
  CONSTRAINT indicative_pricing_revision_positive_snapshot CHECK (
    revision > 0
  ),
  CONSTRAINT indicative_pricing_revision_amount_safe CHECK (
    amount_cents BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT indicative_pricing_revision_currency_eur_only CHECK (
    currency = 'EUR'
  ),
  CONSTRAINT indicative_pricing_revision_service_name_safe CHECK (
    service_name = btrim(service_name)
    AND length(service_name) BETWEEN 1 AND 160
    AND indicative_pricing_public_text_safe(service_name)
  ),
  CONSTRAINT indicative_pricing_revision_note_safe CHECK (
    note IS NULL OR (
      note = btrim(note)
      AND length(note) BETWEEN 1 AND 500
      AND indicative_pricing_public_text_safe(note)
    )
  ),
  CONSTRAINT indicative_pricing_revision_state_consistent CHECK (
    (state = 'ACTIVE' AND archived_at IS NULL)
    OR (state = 'ARCHIVED' AND archived_at IS NOT NULL)
  ),
  CONSTRAINT indicative_pricing_revision_timestamps_ordered CHECK (
    updated_at >= created_at
  )
);

CREATE FUNCTION initialize_indicative_pricing_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_owner_id uuid;
  owner_state user_account_state;
  linked_profile_id uuid;
  linked_state craftsman_profession_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF profile_owner_id IS DISTINCT FROM NEW.created_by_user_id
    OR owner_state IS DISTINCT FROM 'ACTIVE'
  THEN
    RAISE EXCEPTION 'active indicative pricing profile owner required';
  END IF;

  IF NEW.craftsman_profession_id IS NOT NULL THEN
    SELECT profession.craftsman_profile_id, profession.state
    INTO linked_profile_id, linked_state
    FROM craftsman_professions profession
    WHERE profession.id = NEW.craftsman_profession_id
    FOR KEY SHARE;

    IF linked_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
      OR linked_state IS DISTINCT FROM 'ACTIVE'
    THEN
      RAISE EXCEPTION 'indicative pricing profession must be active and owned by the same profile';
    END IF;
  END IF;

  NEW.currency := 'EUR';
  NEW.state := 'ACTIVE';
  NEW.revision := 1;
  NEW.updated_by_user_id := NEW.created_by_user_id;
  NEW.archived_by_user_id := NULL;
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  NEW.archived_at := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER indicative_pricing_entries_insert_guard
BEFORE INSERT ON indicative_pricing_entries
FOR EACH ROW EXECUTE FUNCTION initialize_indicative_pricing_entry();

CREATE FUNCTION guard_indicative_pricing_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_record indicative_pricing_commands%ROWTYPE;
  profile_owner_id uuid;
  owner_state user_account_state;
  linked_profile_id uuid;
  linked_state craftsman_profession_state;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'indicative pricing history cannot be hard-deleted';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'indicative pricing identity and creation provenance are immutable';
  END IF;

  IF NEW.latest_command_id IS NOT DISTINCT FROM OLD.latest_command_id THEN
    RAISE EXCEPTION 'indicative pricing mutation requires a new command';
  END IF;

  SELECT * INTO command_record
  FROM indicative_pricing_commands command
  WHERE command.command_id = NEW.latest_command_id;

  IF NOT FOUND
    OR command_record.entry_id IS DISTINCT FROM OLD.id
    OR command_record.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
  THEN
    RAISE EXCEPTION 'indicative pricing mutation requires matching command provenance';
  END IF;

  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = OLD.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF profile_owner_id IS DISTINCT FROM command_record.actor_user_id
    OR owner_state IS DISTINCT FROM 'ACTIVE'
  THEN
    RAISE EXCEPTION 'active indicative pricing profile owner required';
  END IF;

  IF command_record.command_kind = 'EDIT' THEN
    IF OLD.state IS DISTINCT FROM 'ACTIVE'
      OR NEW.state IS DISTINCT FROM 'ACTIVE'
      OR NEW.archived_by_user_id IS NOT NULL
      OR NEW.archived_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid indicative pricing edit transition';
    END IF;

    IF NEW.craftsman_profession_id IS NOT NULL THEN
      SELECT profession.craftsman_profile_id, profession.state
      INTO linked_profile_id, linked_state
      FROM craftsman_professions profession
      WHERE profession.id = NEW.craftsman_profession_id
      FOR KEY SHARE;

      IF linked_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
        OR linked_state IS DISTINCT FROM 'ACTIVE'
      THEN
        RAISE EXCEPTION 'indicative pricing profession must be active and owned by the same profile';
      END IF;
    END IF;
  ELSIF command_record.command_kind = 'ARCHIVE' THEN
    IF OLD.state IS DISTINCT FROM 'ACTIVE'
      OR NEW.state IS DISTINCT FROM 'ARCHIVED'
      OR ROW(
        NEW.craftsman_profession_id,
        NEW.service_name,
        NEW.price_mode,
        NEW.amount_cents,
        NEW.currency,
        NEW.note
      ) IS DISTINCT FROM ROW(
        OLD.craftsman_profession_id,
        OLD.service_name,
        OLD.price_mode,
        OLD.amount_cents,
        OLD.currency,
        OLD.note
      )
    THEN
      RAISE EXCEPTION 'invalid indicative pricing archive transition';
    END IF;
    NEW.archived_by_user_id := command_record.actor_user_id;
    NEW.archived_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION 'invalid indicative pricing mutation command kind';
  END IF;

  NEW.revision := OLD.revision + 1;
  NEW.created_by_user_id := OLD.created_by_user_id;
  NEW.updated_by_user_id := command_record.actor_user_id;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER indicative_pricing_entries_mutation_guard
BEFORE UPDATE OR DELETE ON indicative_pricing_entries
FOR EACH ROW EXECUTE FUNCTION guard_indicative_pricing_entry_mutation();

CREATE FUNCTION guard_indicative_pricing_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_profile_id uuid;
  profile_owner_id uuid;
  owner_state user_account_state;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'indicative pricing command history is append-only';
  END IF;

  SELECT entry.craftsman_profile_id
  INTO entry_profile_id
  FROM indicative_pricing_entries entry
  WHERE entry.id = NEW.entry_id
  FOR UPDATE;

  SELECT profile.owner_user_id, owner.account_state
  INTO profile_owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF entry_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR profile_owner_id IS DISTINCT FROM NEW.actor_user_id
    OR owner_state IS DISTINCT FROM 'ACTIVE'
  THEN
    RAISE EXCEPTION 'indicative pricing command requires active owner and matching objects';
  END IF;

  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER indicative_pricing_commands_guard
BEFORE INSERT OR UPDATE OR DELETE ON indicative_pricing_commands
FOR EACH ROW EXECUTE FUNCTION guard_indicative_pricing_command();

CREATE FUNCTION guard_indicative_pricing_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command_record indicative_pricing_commands%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'indicative pricing revision history is append-only';
  END IF;

  SELECT * INTO command_record
  FROM indicative_pricing_commands command
  WHERE command.command_id = NEW.command_id;

  IF NOT FOUND
    OR command_record.entry_id IS DISTINCT FROM NEW.entry_id
    OR command_record.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR command_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id
  THEN
    RAISE EXCEPTION 'indicative pricing revision requires matching command provenance';
  END IF;

  NEW.occurred_at := command_record.occurred_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER indicative_pricing_revisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON indicative_pricing_entry_revisions
FOR EACH ROW EXECUTE FUNCTION guard_indicative_pricing_revision();

CREATE FUNCTION assert_indicative_pricing_current_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_entry indicative_pricing_entries%ROWTYPE;
  current_command indicative_pricing_commands%ROWTYPE;
  current_revision indicative_pricing_entry_revisions%ROWTYPE;
  revision_count integer;
BEGIN
  SELECT * INTO current_entry
  FROM indicative_pricing_entries entry
  WHERE entry.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO current_command
  FROM indicative_pricing_commands command
  WHERE command.command_id = current_entry.latest_command_id;
  SELECT * INTO current_revision
  FROM indicative_pricing_entry_revisions history
  WHERE history.entry_id = current_entry.id
    AND history.revision = current_entry.revision;
  SELECT count(*)::integer INTO revision_count
  FROM indicative_pricing_entry_revisions history
  WHERE history.entry_id = current_entry.id;

  IF current_command.command_id IS NULL
    OR current_revision.command_id IS NULL
    OR current_command.entry_id IS DISTINCT FROM current_entry.id
    OR current_command.craftsman_profile_id IS DISTINCT FROM current_entry.craftsman_profile_id
    OR current_command.actor_user_id IS DISTINCT FROM current_entry.updated_by_user_id
    OR current_revision.command_id IS DISTINCT FROM current_command.command_id
    OR current_revision.craftsman_profile_id IS DISTINCT FROM current_entry.craftsman_profile_id
    OR current_revision.craftsman_profession_id IS DISTINCT FROM current_entry.craftsman_profession_id
    OR current_revision.service_name IS DISTINCT FROM current_entry.service_name
    OR current_revision.price_mode IS DISTINCT FROM current_entry.price_mode
    OR current_revision.amount_cents IS DISTINCT FROM current_entry.amount_cents
    OR current_revision.currency IS DISTINCT FROM current_entry.currency
    OR current_revision.note IS DISTINCT FROM current_entry.note
    OR current_revision.state IS DISTINCT FROM current_entry.state
    OR current_revision.actor_user_id IS DISTINCT FROM current_entry.updated_by_user_id
    OR current_revision.created_at IS DISTINCT FROM current_entry.created_at
    OR current_revision.updated_at IS DISTINCT FROM current_entry.updated_at
    OR current_revision.archived_at IS DISTINCT FROM current_entry.archived_at
    OR revision_count IS DISTINCT FROM current_entry.revision
  THEN
    RAISE EXCEPTION 'indicative pricing current state requires contiguous matching revision provenance';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER indicative_pricing_current_provenance_required
AFTER INSERT OR UPDATE ON indicative_pricing_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_indicative_pricing_current_provenance();

CREATE FUNCTION assert_indicative_pricing_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect indicative_pricing_entry_revisions%ROWTYPE;
  current_entry indicative_pricing_entries%ROWTYPE;
BEGIN
  SELECT * INTO effect
  FROM indicative_pricing_entry_revisions history
  WHERE history.command_id = NEW.command_id;
  SELECT * INTO current_entry
  FROM indicative_pricing_entries entry
  WHERE entry.id = NEW.entry_id;

  IF effect.command_id IS NULL
    OR current_entry.id IS NULL
    OR effect.entry_id IS DISTINCT FROM NEW.entry_id
    OR effect.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR effect.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR current_entry.latest_command_id IS DISTINCT FROM NEW.command_id
    OR current_entry.revision IS DISTINCT FROM effect.revision
    OR (NEW.command_kind = 'ADD' AND (effect.revision <> 1 OR effect.state <> 'ACTIVE'))
    OR (NEW.command_kind = 'EDIT' AND (effect.revision <= 1 OR effect.state <> 'ACTIVE'))
    OR (NEW.command_kind = 'ARCHIVE' AND effect.state <> 'ARCHIVED')
  THEN
    RAISE EXCEPTION 'indicative pricing command requires exactly one matching revision effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER indicative_pricing_command_effect_required
AFTER INSERT ON indicative_pricing_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_indicative_pricing_command_effect();
