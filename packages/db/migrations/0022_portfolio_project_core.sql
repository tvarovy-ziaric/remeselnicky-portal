CREATE TYPE portfolio_project_provenance_kind AS ENUM ('SELF_DECLARED');
CREATE TYPE portfolio_project_record_state AS ENUM ('DRAFT', 'HIDDEN', 'ARCHIVED');
CREATE TYPE portfolio_project_duration_unit AS ENUM ('DAYS', 'WEEKS', 'MONTHS');
CREATE TYPE portfolio_project_command_kind AS ENUM (
  'CREATE',
  'EDIT',
  'HIDE',
  'ARCHIVE',
  'RESTORE_DRAFT'
);

CREATE FUNCTION portfolio_project_public_text_safe(value text)
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
    AND value !~* '(\m(adresa|ulica|námestie|trieda|číslo domu|číslo bytu)\M|\m(ul|nám)\.)'
    AND value !~* '\m(zákazník|zákazníčka|klient|klientka|objednávateľ|objednávateľka)\M[[:space:]]*(menom|:|-)[[:space:]]*[[:alpha:]]'
    AND value !~* '\m(heslo|password|api[ _-]?key|access[ _-]?token|secret|tajný kľúč)\M';
$$;

CREATE FUNCTION portfolio_uuid_array_valid(value uuid[], minimum_count integer, maximum_count integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT cardinality(value) BETWEEN minimum_count AND maximum_count
    AND cardinality(value) = (
      SELECT count(DISTINCT item)::integer FROM unnest(value) item
    );
$$;

CREATE TABLE portfolio_projects (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provenance_kind portfolio_project_provenance_kind NOT NULL DEFAULT 'SELF_DECLARED',
  record_state portfolio_project_record_state NOT NULL DEFAULT 'DRAFT',
  title text NOT NULL,
  short_description text NOT NULL,
  contribution text,
  materials_and_technologies text,
  problem text,
  solution text,
  duration_value integer,
  duration_unit portfolio_project_duration_unit,
  indicative_price_min_cents bigint,
  indicative_price_max_cents bigint,
  currency char(3) NOT NULL DEFAULT 'EUR',
  municipality_code text REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  district_code text REFERENCES location_districts(code) ON DELETE RESTRICT,
  profession_ids uuid[] NOT NULL,
  skill_ids uuid[] NOT NULL DEFAULT '{}',
  specialization_ids uuid[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  latest_command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT portfolio_projects_title_safe CHECK (
    title = btrim(title) AND length(title) BETWEEN 2 AND 120
      AND portfolio_project_public_text_safe(title)
  ),
  CONSTRAINT portfolio_projects_short_description_safe CHECK (
    short_description = btrim(short_description)
      AND length(short_description) BETWEEN 10 AND 600
      AND portfolio_project_public_text_safe(short_description)
  ),
  CONSTRAINT portfolio_projects_optional_text_safe CHECK (
    (contribution IS NULL OR contribution = btrim(contribution)
      AND length(contribution) BETWEEN 1 AND 600
      AND portfolio_project_public_text_safe(contribution))
    AND (materials_and_technologies IS NULL OR materials_and_technologies = btrim(materials_and_technologies)
      AND length(materials_and_technologies) BETWEEN 1 AND 1000
      AND portfolio_project_public_text_safe(materials_and_technologies))
    AND (problem IS NULL OR problem = btrim(problem)
      AND length(problem) BETWEEN 1 AND 1500
      AND portfolio_project_public_text_safe(problem))
    AND (solution IS NULL OR solution = btrim(solution)
      AND length(solution) BETWEEN 1 AND 1500
      AND portfolio_project_public_text_safe(solution))
  ),
  CONSTRAINT portfolio_projects_duration_consistent CHECK (
    (duration_value IS NULL AND duration_unit IS NULL)
    OR (duration_value BETWEEN 1 AND 1200 AND duration_unit IS NOT NULL)
  ),
  CONSTRAINT portfolio_projects_indicative_price_consistent CHECK (
    (indicative_price_min_cents IS NULL AND indicative_price_max_cents IS NULL)
    OR (
      indicative_price_min_cents BETWEEN 0 AND 9007199254740991
      AND indicative_price_max_cents BETWEEN indicative_price_min_cents AND 9007199254740991
      AND currency = 'EUR'
    )
  ),
  CONSTRAINT portfolio_projects_currency_eur CHECK (currency = 'EUR'),
  CONSTRAINT portfolio_projects_location_shape CHECK (
    municipality_code IS NULL OR district_code IS NOT NULL
  ),
  CONSTRAINT portfolio_projects_tags_bounded_unique CHECK (
    portfolio_uuid_array_valid(profession_ids, 1, 20)
    AND portfolio_uuid_array_valid(skill_ids, 0, 100)
    AND portfolio_uuid_array_valid(specialization_ids, 0, 100)
  ),
  CONSTRAINT portfolio_projects_revision_positive CHECK (revision > 0),
  CONSTRAINT portfolio_projects_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE INDEX portfolio_projects_profile_state_idx
ON portfolio_projects (craftsman_profile_id, record_state, updated_at DESC, id);

CREATE TABLE portfolio_project_commands (
  command_id uuid PRIMARY KEY,
  command_kind portfolio_project_command_kind NOT NULL,
  portfolio_project_id uuid NOT NULL REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  resulting_revision integer NOT NULL CHECK (resulting_revision > 0),
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE portfolio_projects
ADD CONSTRAINT portfolio_projects_latest_command_fkey
FOREIGN KEY (latest_command_id)
REFERENCES portfolio_project_commands(command_id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE portfolio_project_revisions (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE
    REFERENCES portfolio_project_commands(command_id) ON DELETE RESTRICT,
  portfolio_project_id uuid NOT NULL REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  record_state portfolio_project_record_state NOT NULL,
  title text NOT NULL,
  short_description text NOT NULL,
  contribution text,
  materials_and_technologies text,
  problem text,
  solution text,
  duration_value integer,
  duration_unit portfolio_project_duration_unit,
  indicative_price_min_cents bigint,
  indicative_price_max_cents bigint,
  currency char(3) NOT NULL,
  municipality_code text REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  district_code text REFERENCES location_districts(code) ON DELETE RESTRICT,
  profession_ids uuid[] NOT NULL,
  skill_ids uuid[] NOT NULL,
  specialization_ids uuid[] NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (portfolio_project_id, revision),
  CONSTRAINT portfolio_project_revisions_snapshot_safe CHECK (
    title = btrim(title) AND length(title) BETWEEN 2 AND 120
      AND portfolio_project_public_text_safe(title)
    AND short_description = btrim(short_description)
      AND length(short_description) BETWEEN 10 AND 600
      AND portfolio_project_public_text_safe(short_description)
    AND (contribution IS NULL OR portfolio_project_public_text_safe(contribution))
    AND (materials_and_technologies IS NULL OR portfolio_project_public_text_safe(materials_and_technologies))
    AND (problem IS NULL OR portfolio_project_public_text_safe(problem))
    AND (solution IS NULL OR portfolio_project_public_text_safe(solution))
    AND portfolio_uuid_array_valid(profession_ids, 1, 20)
    AND portfolio_uuid_array_valid(skill_ids, 0, 100)
    AND portfolio_uuid_array_valid(specialization_ids, 0, 100)
  )
);

CREATE FUNCTION lock_active_portfolio_owner(candidate_profile_id uuid, candidate_actor_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; owner_state user_account_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state INTO owner_id, owner_state
  FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = candidate_profile_id FOR UPDATE OF profile, owner;
  IF owner_id IS NULL OR owner_id IS DISTINCT FROM candidate_actor_id OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active portfolio author required';
  END IF;
END;
$$;

CREATE FUNCTION validate_portfolio_tags_and_location(
  candidate_profile_id uuid,
  candidate_profession_ids uuid[],
  candidate_skill_ids uuid[],
  candidate_specialization_ids uuid[],
  prior_profession_ids uuid[],
  prior_skill_ids uuid[],
  prior_specialization_ids uuid[],
  candidate_municipality_code text,
  candidate_district_code text
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE expected_count integer; actual_count integer;
BEGIN
  expected_count := cardinality(candidate_profession_ids);
  SELECT count(*) INTO actual_count FROM craftsman_professions assignment
  WHERE assignment.id = ANY(candidate_profession_ids)
    AND assignment.craftsman_profile_id = candidate_profile_id
    AND (assignment.state = 'ACTIVE' OR assignment.id = ANY(COALESCE(prior_profession_ids, '{}')));
  IF actual_count <> expected_count THEN RAISE EXCEPTION 'owned relevant profession tags required'; END IF;

  expected_count := cardinality(candidate_skill_ids);
  SELECT count(*) INTO actual_count FROM craftsman_skills skill
  WHERE skill.id = ANY(candidate_skill_ids)
    AND skill.craftsman_profile_id = candidate_profile_id
    AND (skill.state = 'ACTIVE' OR skill.id = ANY(COALESCE(prior_skill_ids, '{}')))
    AND EXISTS (
      SELECT 1 FROM craftsman_skill_profession_links link
      WHERE link.craftsman_skill_id = skill.id
        AND link.craftsman_profession_id = ANY(candidate_profession_ids)
    );
  IF actual_count <> expected_count THEN RAISE EXCEPTION 'owned relevant skill tags required'; END IF;

  expected_count := cardinality(candidate_specialization_ids);
  SELECT count(*) INTO actual_count FROM craftsman_specializations specialization
  WHERE specialization.id = ANY(candidate_specialization_ids)
    AND specialization.craftsman_profile_id = candidate_profile_id
    AND (specialization.state = 'ACTIVE' OR specialization.id = ANY(COALESCE(prior_specialization_ids, '{}')))
    AND specialization.craftsman_profession_id = ANY(candidate_profession_ids);
  IF actual_count <> expected_count THEN RAISE EXCEPTION 'owned relevant specialization tags required'; END IF;

  IF candidate_district_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM location_districts district
    WHERE district.code = candidate_district_code AND district.is_active
  ) THEN RAISE EXCEPTION 'active approximate district required'; END IF;
  IF candidate_municipality_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM location_municipalities municipality
    WHERE municipality.code = candidate_municipality_code
      AND municipality.district_code = candidate_district_code
      AND municipality.is_active
  ) THEN RAISE EXCEPTION 'active approximate municipality required'; END IF;
END;
$$;

CREATE FUNCTION enforce_portfolio_project_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_active_portfolio_owner(NEW.craftsman_profile_id, NEW.author_user_id);
  IF NEW.provenance_kind <> 'SELF_DECLARED' OR NEW.record_state <> 'DRAFT'
    OR NEW.revision <> 1 THEN
    RAISE EXCEPTION 'portfolio project must start as self-declared private draft';
  END IF;
  PERFORM validate_portfolio_tags_and_location(
    NEW.craftsman_profile_id, NEW.profession_ids, NEW.skill_ids,
    NEW.specialization_ids, NULL, NULL, NULL,
    NEW.municipality_code, NEW.district_code
  );
  NEW.created_at := clock_timestamp(); NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_project_insert_guard
BEFORE INSERT ON portfolio_projects
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_insert();

CREATE FUNCTION enforce_portfolio_project_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project portfolio_projects%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO project FROM portfolio_projects WHERE id = NEW.portfolio_project_id FOR UPDATE;
  IF project.id IS NULL OR project.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id THEN
    RAISE EXCEPTION 'portfolio command target mismatch';
  END IF;
  PERFORM lock_active_portfolio_owner(NEW.craftsman_profile_id, NEW.actor_user_id);
  IF project.author_user_id IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'portfolio author is immutable';
  END IF;
  IF NEW.command_kind = 'CREATE' THEN
    IF NEW.expected_revision <> 0 OR NEW.resulting_revision <> 1
      OR project.revision <> 1 OR project.latest_command_id IS DISTINCT FROM NEW.command_id THEN
      RAISE EXCEPTION 'invalid portfolio create command';
    END IF;
  ELSIF NEW.expected_revision <> project.revision
    OR NEW.resulting_revision <> project.revision + 1 THEN
    RAISE EXCEPTION 'stale portfolio command revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_project_command_guard
BEFORE INSERT ON portfolio_project_commands
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_command();

CREATE FUNCTION enforce_portfolio_project_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command portfolio_project_commands%ROWTYPE; content_changed boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.provenance_kind IS DISTINCT FROM OLD.provenance_kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'portfolio authorship and provenance are immutable';
  END IF;
  SELECT * INTO command FROM portfolio_project_commands
  WHERE command_id = NEW.latest_command_id;
  IF command.command_id IS NULL OR command.command_kind = 'CREATE'
    OR command.portfolio_project_id IS DISTINCT FROM OLD.id
    OR command.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR command.actor_user_id IS DISTINCT FROM OLD.author_user_id
    OR command.expected_revision IS DISTINCT FROM OLD.revision
    OR command.resulting_revision IS DISTINCT FROM OLD.revision + 1
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'portfolio update requires matching command provenance';
  END IF;
  content_changed := ROW(
    NEW.title, NEW.short_description, NEW.contribution,
    NEW.materials_and_technologies, NEW.problem, NEW.solution,
    NEW.duration_value, NEW.duration_unit,
    NEW.indicative_price_min_cents, NEW.indicative_price_max_cents,
    NEW.currency, NEW.municipality_code, NEW.district_code,
    NEW.profession_ids, NEW.skill_ids, NEW.specialization_ids
  ) IS DISTINCT FROM ROW(
    OLD.title, OLD.short_description, OLD.contribution,
    OLD.materials_and_technologies, OLD.problem, OLD.solution,
    OLD.duration_value, OLD.duration_unit,
    OLD.indicative_price_min_cents, OLD.indicative_price_max_cents,
    OLD.currency, OLD.municipality_code, OLD.district_code,
    OLD.profession_ids, OLD.skill_ids, OLD.specialization_ids
  );
  IF command.command_kind = 'EDIT' THEN
    IF NEW.record_state IS DISTINCT FROM OLD.record_state OR NOT content_changed
      OR OLD.record_state = 'ARCHIVED' THEN
      RAISE EXCEPTION 'invalid portfolio edit';
    END IF;
  ELSIF content_changed THEN
    RAISE EXCEPTION 'state command cannot rewrite portfolio content';
  ELSIF command.command_kind = 'HIDE'
    AND NOT (OLD.record_state = 'DRAFT' AND NEW.record_state = 'HIDDEN') THEN
    RAISE EXCEPTION 'invalid portfolio hide transition';
  ELSIF command.command_kind = 'ARCHIVE'
    AND NOT (OLD.record_state IN ('DRAFT', 'HIDDEN') AND NEW.record_state = 'ARCHIVED') THEN
    RAISE EXCEPTION 'invalid portfolio archive transition';
  ELSIF command.command_kind = 'RESTORE_DRAFT'
    AND NOT (OLD.record_state IN ('HIDDEN', 'ARCHIVED') AND NEW.record_state = 'DRAFT') THEN
    RAISE EXCEPTION 'invalid portfolio restore transition';
  END IF;
  PERFORM validate_portfolio_tags_and_location(
    NEW.craftsman_profile_id, NEW.profession_ids, NEW.skill_ids,
    NEW.specialization_ids, OLD.profession_ids, OLD.skill_ids,
    OLD.specialization_ids, NEW.municipality_code, NEW.district_code
  );
  NEW.updated_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_project_update_guard
BEFORE UPDATE ON portfolio_projects
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_update();

CREATE FUNCTION enforce_portfolio_project_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project portfolio_projects%ROWTYPE; command portfolio_project_commands%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO project FROM portfolio_projects WHERE id = NEW.portfolio_project_id FOR UPDATE;
  SELECT * INTO command FROM portfolio_project_commands WHERE command_id = NEW.command_id;
  IF project.id IS NULL OR command.command_id IS NULL
    OR command.portfolio_project_id IS DISTINCT FROM project.id
    OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR project.latest_command_id IS DISTINCT FROM command.command_id
    OR NEW.revision IS DISTINCT FROM project.revision
    OR ROW(NEW.record_state, NEW.title, NEW.short_description, NEW.contribution,
      NEW.materials_and_technologies, NEW.problem, NEW.solution,
      NEW.duration_value, NEW.duration_unit, NEW.indicative_price_min_cents,
      NEW.indicative_price_max_cents, NEW.currency, NEW.municipality_code,
      NEW.district_code, NEW.profession_ids, NEW.skill_ids, NEW.specialization_ids)
      IS DISTINCT FROM
      ROW(project.record_state, project.title, project.short_description,
        project.contribution, project.materials_and_technologies, project.problem,
        project.solution, project.duration_value, project.duration_unit,
        project.indicative_price_min_cents, project.indicative_price_max_cents,
        project.currency, project.municipality_code, project.district_code,
        project.profession_ids, project.skill_ids, project.specialization_ids)
  THEN RAISE EXCEPTION 'portfolio revision must be an exact command snapshot'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_project_revision_guard
BEFORE INSERT ON portfolio_project_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_revision();

CREATE FUNCTION ensure_portfolio_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM portfolio_projects project
    JOIN portfolio_project_revisions revision
      ON revision.portfolio_project_id = project.id
      AND revision.command_id = NEW.command_id
      AND revision.revision = NEW.resulting_revision
    WHERE project.id = NEW.portfolio_project_id
      AND project.latest_command_id = NEW.command_id
      AND project.revision = NEW.resulting_revision
  ) THEN RAISE EXCEPTION 'portfolio command requires exact project and revision effects'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER portfolio_command_effect_required
AFTER INSERT ON portfolio_project_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_portfolio_command_effect();

CREATE FUNCTION ensure_portfolio_initial_command()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM portfolio_project_commands command
    WHERE command.command_id = NEW.latest_command_id
      AND command.portfolio_project_id = NEW.id
      AND command.command_kind = 'CREATE'
  ) THEN RAISE EXCEPTION 'portfolio project requires create command provenance'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER portfolio_initial_command_required
AFTER INSERT ON portfolio_projects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_portfolio_initial_command();

CREATE FUNCTION reject_portfolio_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'portfolio history is append-only'; END;
$$;
CREATE TRIGGER portfolio_projects_no_delete
BEFORE DELETE ON portfolio_projects
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_history_mutation();
CREATE TRIGGER portfolio_commands_immutable
BEFORE UPDATE OR DELETE ON portfolio_project_commands
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_history_mutation();
CREATE TRIGGER portfolio_revisions_immutable
BEFORE UPDATE OR DELETE ON portfolio_project_revisions
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_history_mutation();

CREATE VIEW current_portfolio_projects AS
SELECT project.id, project.craftsman_profile_id, project.author_user_id,
  project.provenance_kind, 'UNVERIFIED'::text AS evidence_status,
  project.record_state, project.title, project.short_description,
  project.contribution, project.materials_and_technologies,
  project.problem, project.solution, project.duration_value,
  project.duration_unit, project.indicative_price_min_cents,
  project.indicative_price_max_cents, project.currency,
  project.municipality_code, project.district_code,
  project.profession_ids, project.skill_ids, project.specialization_ids,
  project.revision, project.created_at, project.updated_at
FROM portfolio_projects project;

COMMENT ON VIEW current_portfolio_projects IS
  'R1-013 private self-declared draft projection. It has no media, publication, verified Job provenance, exact address, or customer identity fields.';
