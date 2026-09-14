CREATE TYPE featured_project_command_kind AS ENUM ('PIN', 'UNPIN', 'REORDER');

CREATE TABLE featured_project_sets (
  craftsman_profile_id uuid PRIMARY KEY
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  project_ids uuid[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  latest_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT featured_project_sets_max_three_unique CHECK (
    portfolio_uuid_array_valid(project_ids, 0, 3)
  ),
  CONSTRAINT featured_project_sets_initial_shape CHECK (
    (revision = 0 AND latest_command_id IS NULL AND cardinality(project_ids) = 0)
    OR (revision > 0 AND latest_command_id IS NOT NULL)
  ),
  CONSTRAINT featured_project_sets_timestamps_ordered CHECK (updated_at >= created_at)
);

INSERT INTO featured_project_sets (craftsman_profile_id)
SELECT id FROM craftsman_profiles;

CREATE FUNCTION initialize_featured_project_set()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO featured_project_sets (
    craftsman_profile_id, created_at, updated_at
  ) VALUES (NEW.id, NEW.created_at, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER featured_project_set_initialize
AFTER INSERT ON craftsman_profiles
FOR EACH ROW EXECUTE FUNCTION initialize_featured_project_set();

CREATE TABLE featured_project_commands (
  command_id uuid PRIMARY KEY,
  command_kind featured_project_command_kind NOT NULL,
  craftsman_profile_id uuid NOT NULL
    REFERENCES featured_project_sets(craftsman_profile_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  resulting_revision integer NOT NULL,
  target_project_id uuid REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  resulting_project_ids uuid[] NOT NULL,
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT featured_project_commands_revision_step CHECK (
    resulting_revision = expected_revision + 1
  ),
  CONSTRAINT featured_project_commands_max_three_unique CHECK (
    portfolio_uuid_array_valid(resulting_project_ids, 0, 3)
  ),
  CONSTRAINT featured_project_commands_shape CHECK (
    (command_kind IN ('PIN', 'UNPIN') AND target_project_id IS NOT NULL)
    OR (command_kind = 'REORDER' AND target_project_id IS NULL)
  )
);

ALTER TABLE featured_project_sets
ADD CONSTRAINT featured_project_sets_latest_command_fkey
FOREIGN KEY (latest_command_id) REFERENCES featured_project_commands(command_id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE featured_project_revisions (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE
    REFERENCES featured_project_commands(command_id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES featured_project_sets(craftsman_profile_id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  project_ids uuid[] NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (craftsman_profile_id, revision),
  CONSTRAINT featured_project_revisions_max_three_unique CHECK (
    portfolio_uuid_array_valid(project_ids, 0, 3)
  )
);

CREATE FUNCTION validate_featured_project_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_set featured_project_sets%ROWTYPE;
DECLARE eligible_count integer;
BEGIN
  NEW.occurred_at := clock_timestamp();
  PERFORM lock_active_portfolio_owner(NEW.craftsman_profile_id, NEW.actor_user_id);

  SELECT * INTO current_set FROM featured_project_sets
  WHERE craftsman_profile_id = NEW.craftsman_profile_id FOR UPDATE;
  IF current_set.craftsman_profile_id IS NULL
    OR current_set.revision IS DISTINCT FROM NEW.expected_revision
    OR NEW.resulting_revision IS DISTINCT FROM current_set.revision + 1 THEN
    RAISE EXCEPTION 'stale featured project revision';
  END IF;

  PERFORM project.id FROM portfolio_projects project
  WHERE project.id = ANY(NEW.resulting_project_ids)
  ORDER BY project.id FOR UPDATE;
  SELECT count(*) INTO eligible_count FROM portfolio_projects project
  WHERE project.id = ANY(NEW.resulting_project_ids)
    AND project.craftsman_profile_id = NEW.craftsman_profile_id
    AND project.author_user_id = NEW.actor_user_id
    AND project.record_state = 'DRAFT';
  IF eligible_count <> cardinality(NEW.resulting_project_ids) THEN
    RAISE EXCEPTION 'owned current draft featured projects required';
  END IF;

  IF NEW.command_kind = 'PIN' THEN
    IF NEW.target_project_id = ANY(current_set.project_ids)
      OR NEW.resulting_project_ids IS DISTINCT FROM
        array_append(current_set.project_ids, NEW.target_project_id) THEN
      RAISE EXCEPTION 'invalid featured project pin effect';
    END IF;
  ELSIF NEW.command_kind = 'UNPIN' THEN
    IF NOT NEW.target_project_id = ANY(current_set.project_ids)
      OR NEW.resulting_project_ids IS DISTINCT FROM
        array_remove(current_set.project_ids, NEW.target_project_id) THEN
      RAISE EXCEPTION 'invalid featured project unpin effect';
    END IF;
  ELSIF cardinality(NEW.resulting_project_ids) <> cardinality(current_set.project_ids)
    OR NEW.resulting_project_ids = current_set.project_ids
    OR EXISTS (
      SELECT 1 FROM unnest(NEW.resulting_project_ids) project_id
      WHERE NOT project_id = ANY(current_set.project_ids)
    ) THEN
    RAISE EXCEPTION 'invalid featured project reorder effect';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER featured_project_command_guard
BEFORE INSERT ON featured_project_commands
FOR EACH ROW EXECUTE FUNCTION validate_featured_project_command();

CREATE FUNCTION validate_featured_project_set_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source featured_project_commands%ROWTYPE;
BEGIN
  IF NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'featured project set identity is immutable';
  END IF;
  SELECT * INTO source FROM featured_project_commands
  WHERE command_id = NEW.latest_command_id;
  IF source.command_id IS NULL
    OR source.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR source.expected_revision IS DISTINCT FROM OLD.revision
    OR source.resulting_revision IS DISTINCT FROM NEW.revision
    OR source.resulting_project_ids IS DISTINCT FROM NEW.project_ids
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'featured project set update requires matching command';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER featured_project_set_update_guard
BEFORE UPDATE ON featured_project_sets
FOR EACH ROW EXECUTE FUNCTION validate_featured_project_set_update();

CREATE FUNCTION validate_featured_project_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_set featured_project_sets%ROWTYPE;
DECLARE source featured_project_commands%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO current_set FROM featured_project_sets
  WHERE craftsman_profile_id = NEW.craftsman_profile_id FOR UPDATE;
  SELECT * INTO source FROM featured_project_commands WHERE command_id = NEW.command_id;
  IF current_set.craftsman_profile_id IS NULL OR source.command_id IS NULL
    OR current_set.latest_command_id IS DISTINCT FROM source.command_id
    OR current_set.revision IS DISTINCT FROM NEW.revision
    OR current_set.project_ids IS DISTINCT FROM NEW.project_ids
    OR source.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR source.resulting_revision IS DISTINCT FROM NEW.revision
    OR source.resulting_project_ids IS DISTINCT FROM NEW.project_ids
    OR source.actor_user_id IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'featured project revision requires exact command snapshot';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER featured_project_revision_guard
BEFORE INSERT ON featured_project_revisions
FOR EACH ROW EXECUTE FUNCTION validate_featured_project_revision();

CREATE FUNCTION ensure_featured_project_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM featured_project_sets current_set
    JOIN featured_project_revisions revision
      ON revision.craftsman_profile_id = current_set.craftsman_profile_id
      AND revision.command_id = NEW.command_id
      AND revision.revision = NEW.resulting_revision
      AND revision.project_ids = NEW.resulting_project_ids
    WHERE current_set.craftsman_profile_id = NEW.craftsman_profile_id
      AND current_set.latest_command_id = NEW.command_id
      AND current_set.revision = NEW.resulting_revision
      AND current_set.project_ids = NEW.resulting_project_ids
  ) THEN
    RAISE EXCEPTION 'featured project command requires exact set and revision effects';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER featured_project_command_effect_required
AFTER INSERT ON featured_project_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_featured_project_command_effect();

CREATE FUNCTION reject_featured_project_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'featured project history is append-only'; END;
$$;
CREATE TRIGGER featured_project_sets_no_delete
BEFORE DELETE ON featured_project_sets
FOR EACH ROW EXECUTE FUNCTION reject_featured_project_history_mutation();
CREATE TRIGGER featured_project_commands_append_only
BEFORE UPDATE OR DELETE ON featured_project_commands
FOR EACH ROW EXECUTE FUNCTION reject_featured_project_history_mutation();
CREATE TRIGGER featured_project_revisions_append_only
BEFORE UPDATE OR DELETE ON featured_project_revisions
FOR EACH ROW EXECUTE FUNCTION reject_featured_project_history_mutation();

CREATE VIEW current_featured_project_candidates AS
SELECT featured.craftsman_profile_id, featured.revision,
  ordered.portfolio_project_id, ordered.position::integer AS position
FROM featured_project_sets featured
CROSS JOIN LATERAL unnest(featured.project_ids)
  WITH ORDINALITY AS ordered(portfolio_project_id, position);

COMMENT ON VIEW current_featured_project_candidates IS
  'Private ordered IDs only. This is not public eligibility: public consumers must independently intersect profile, project, photo/media and consent authorization; until that contract exists they return no rows.';
