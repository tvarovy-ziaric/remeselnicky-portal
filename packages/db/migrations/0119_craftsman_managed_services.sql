CREATE TYPE craftsman_service_state AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE craftsman_service_command_kind AS ENUM ('ADD', 'DEACTIVATE');

CREATE TABLE craftsman_services (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  taxonomy_release_id uuid NOT NULL,
  service_code text NOT NULL,
  state craftsman_service_state NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_command_id uuid,
  deactivated_at timestamptz,
  FOREIGN KEY (taxonomy_release_id, service_code)
    REFERENCES taxonomy_services(release_id, service_code) ON DELETE RESTRICT,
  CONSTRAINT craftsman_service_state_consistent CHECK (
    (state = 'ACTIVE' AND deactivated_by_user_id IS NULL
      AND deactivation_command_id IS NULL AND deactivated_at IS NULL)
    OR
    (state = 'INACTIVE' AND deactivated_by_user_id IS NOT NULL
      AND deactivation_command_id IS NOT NULL AND deactivated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX craftsman_services_one_active_code_per_profile
ON craftsman_services (craftsman_profile_id, service_code)
WHERE state = 'ACTIVE';
CREATE INDEX craftsman_services_public_count_idx
ON craftsman_services (service_code, craftsman_profile_id)
WHERE state = 'ACTIVE';

CREATE TABLE craftsman_service_profession_links (
  craftsman_service_id uuid NOT NULL
    REFERENCES craftsman_services(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid NOT NULL
    REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (craftsman_service_id, craftsman_profession_id)
);

CREATE TABLE craftsman_service_commands (
  command_id uuid PRIMARY KEY,
  command_kind craftsman_service_command_kind NOT NULL,
  craftsman_service_id uuid NOT NULL
    REFERENCES craftsman_services(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_fingerprint char(64) NOT NULL
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX craftsman_service_one_add_command
ON craftsman_service_commands (craftsman_service_id)
WHERE command_kind = 'ADD';
CREATE UNIQUE INDEX craftsman_service_one_deactivate_command
ON craftsman_service_commands (craftsman_service_id)
WHERE command_kind = 'DEACTIVATE';

ALTER TABLE craftsman_services
ADD CONSTRAINT craftsman_services_deactivation_command_fkey
FOREIGN KEY (deactivation_command_id)
REFERENCES craftsman_service_commands(command_id) ON DELETE RESTRICT;

CREATE FUNCTION enforce_craftsman_service_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_active_capability_owner(
    NEW.craftsman_profile_id, NEW.created_by_user_id
  );
  IF NEW.state <> 'ACTIVE' OR NEW.deactivated_by_user_id IS NOT NULL
    OR NEW.deactivation_command_id IS NOT NULL OR NEW.deactivated_at IS NOT NULL
  THEN RAISE EXCEPTION 'craftsman service must start ACTIVE'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM current_service_taxonomy service
    WHERE service.release_id = NEW.taxonomy_release_id
      AND service.service_code = NEW.service_code
      AND service.state = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'active governed service required'; END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_service_insert_guard
BEFORE INSERT ON craftsman_services
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_service_insert();

CREATE FUNCTION enforce_craftsman_service_profession_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer craftsman_services%ROWTYPE; assignment craftsman_professions%ROWTYPE;
BEGIN
  SELECT * INTO offer FROM craftsman_services
    WHERE id = NEW.craftsman_service_id FOR UPDATE;
  SELECT * INTO assignment FROM craftsman_professions
    WHERE id = NEW.craftsman_profession_id FOR UPDATE;
  IF offer.id IS NULL OR assignment.id IS NULL
    OR offer.craftsman_profile_id IS DISTINCT FROM assignment.craftsman_profile_id
    OR offer.state <> 'ACTIVE' OR assignment.state <> 'ACTIVE'
  THEN RAISE EXCEPTION 'active owned profession is required for service'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM taxonomy_service_professions relation
    WHERE relation.release_id = offer.taxonomy_release_id
      AND relation.service_code = offer.service_code
      AND relation.profession_code = assignment.profession_code
  ) THEN RAISE EXCEPTION 'service is not governed for profession'; END IF;
  NEW.linked_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_service_profession_link_guard
BEFORE INSERT ON craftsman_service_profession_links
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_service_profession_link();

CREATE FUNCTION enforce_craftsman_service_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE offer craftsman_services%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO offer FROM craftsman_services
    WHERE id = NEW.craftsman_service_id FOR UPDATE;
  IF offer.id IS NULL OR offer.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
  THEN RAISE EXCEPTION 'service command target mismatch'; END IF;
  PERFORM lock_active_capability_owner(NEW.craftsman_profile_id, NEW.actor_user_id);
  IF offer.state <> 'ACTIVE' THEN RAISE EXCEPTION 'service is not active'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_service_command_guard
BEFORE INSERT ON craftsman_service_commands
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_service_command();

CREATE FUNCTION enforce_craftsman_service_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command craftsman_service_commands%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.taxonomy_release_id IS DISTINCT FROM OLD.taxonomy_release_id
    OR NEW.service_code IS DISTINCT FROM OLD.service_code
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state <> 'ACTIVE' OR NEW.state <> 'INACTIVE'
  THEN RAISE EXCEPTION 'invalid service history mutation'; END IF;
  SELECT * INTO command FROM craftsman_service_commands
    WHERE command_id = NEW.deactivation_command_id;
  IF command.command_id IS NULL OR command.command_kind <> 'DEACTIVATE'
    OR command.craftsman_service_id IS DISTINCT FROM OLD.id
    OR command.actor_user_id IS DISTINCT FROM NEW.deactivated_by_user_id
  THEN RAISE EXCEPTION 'service deactivation requires command provenance'; END IF;
  NEW.deactivated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_service_update_guard
BEFORE UPDATE ON craftsman_services
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_service_update();

CREATE FUNCTION ensure_craftsman_service_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_kind = 'ADD' AND NOT EXISTS (
    SELECT 1 FROM craftsman_services offer
    WHERE offer.id = NEW.craftsman_service_id AND offer.state = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM craftsman_service_profession_links link
        WHERE link.craftsman_service_id = offer.id
      )
  ) THEN RAISE EXCEPTION 'service add command requires an active linked offer';
  ELSIF NEW.command_kind = 'DEACTIVATE' AND NOT EXISTS (
    SELECT 1 FROM craftsman_services offer
    WHERE offer.id = NEW.craftsman_service_id AND offer.state = 'INACTIVE'
      AND offer.deactivation_command_id = NEW.command_id
  ) THEN RAISE EXCEPTION 'service deactivation command requires inactive offer';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER craftsman_service_command_effect_required
AFTER INSERT ON craftsman_service_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_service_command_effect();

CREATE FUNCTION ensure_craftsman_service_initial_command()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM craftsman_service_commands command
    WHERE command.craftsman_service_id = NEW.id AND command.command_kind = 'ADD'
  ) THEN RAISE EXCEPTION 'service requires add command provenance'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER craftsman_service_initial_command_required
AFTER INSERT ON craftsman_services DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_service_initial_command();

CREATE TRIGGER craftsman_services_no_delete
BEFORE DELETE ON craftsman_services
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_service_links_immutable
BEFORE UPDATE OR DELETE ON craftsman_service_profession_links
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_service_commands_immutable
BEFORE UPDATE OR DELETE ON craftsman_service_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();

CREATE VIEW current_craftsman_services AS
SELECT offer.id, offer.craftsman_profile_id, offer.taxonomy_release_id,
  offer.service_code, offer.state,
  links.craftsman_profession_ids,
  offer.created_at, offer.deactivated_at
FROM craftsman_services offer
JOIN LATERAL (
  SELECT array_agg(link.craftsman_profession_id ORDER BY link.craftsman_profession_id)
    AS craftsman_profession_ids
  FROM craftsman_service_profession_links link
  WHERE link.craftsman_service_id = offer.id
) links ON true;

CREATE VIEW current_searchable_craftsman_services
WITH (security_invoker = true)
AS
SELECT searchable.craftsman_profile_id, offer.service_code,
  current_service.label_sk,
  current_service.profession_codes
FROM current_searchable_craftsman_profiles searchable
JOIN current_craftsman_services offer
  ON offer.craftsman_profile_id = searchable.craftsman_profile_id
 AND offer.state = 'ACTIVE'
JOIN current_service_taxonomy current_service
  ON current_service.service_code = offer.service_code
 AND current_service.state = 'ACTIVE';
