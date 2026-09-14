CREATE TYPE craftsman_capability_state AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE craftsman_skill_identity_kind AS ENUM ('CANONICAL', 'CUSTOM');
CREATE TYPE craftsman_specialization_command_kind AS ENUM ('ADD', 'DEACTIVATE');
CREATE TYPE craftsman_skill_command_kind AS ENUM ('ADD', 'MAP_CUSTOM', 'DEACTIVATE');

CREATE FUNCTION craftsman_capability_public_text_safe(value text)
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

-- Skills use their own governed catalog. This keeps already sealed profession
-- taxonomy releases and their checksums immutable while still pinning every
-- catalog release to the exact profession taxonomy it was reviewed against.
CREATE TABLE skill_catalog_releases (
  release_id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  profession_taxonomy_release_id uuid NOT NULL
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  content_class taxonomy_content_class NOT NULL,
  review_state taxonomy_review_state NOT NULL,
  review_reference text,
  supersedes_release_id uuid UNIQUE
    REFERENCES skill_catalog_releases(release_id) ON DELETE RESTRICT,
  checksum_sha256 char(64) NOT NULL UNIQUE,
  installation_txid bigint NOT NULL DEFAULT txid_current(),
  installed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (release_id, profession_taxonomy_release_id),
  CONSTRAINT skill_catalog_release_chain CHECK (
    (version = 1 AND supersedes_release_id IS NULL)
    OR (version > 1 AND supersedes_release_id IS NOT NULL)
  ),
  CONSTRAINT skill_catalog_review_governance CHECK (
    (
      content_class = 'PLACEHOLDER'
      AND review_state = 'HUMAN_REVIEW_PENDING'
      AND review_reference IS NULL
    )
    OR (
      content_class = 'CANONICAL'
      AND review_state = 'HUMAN_REVIEW_APPROVED'
      AND review_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
    )
  ),
  CONSTRAINT skill_catalog_checksum_safe CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE skill_catalog_skills (
  release_id uuid NOT NULL
    REFERENCES skill_catalog_releases(release_id) ON DELETE RESTRICT,
  skill_code text NOT NULL,
  slug text NOT NULL,
  label_sk text NOT NULL,
  state taxonomy_entry_state NOT NULL,
  replaced_by_code text,
  PRIMARY KEY (release_id, skill_code),
  UNIQUE (release_id, slug),
  FOREIGN KEY (release_id, replaced_by_code)
    REFERENCES skill_catalog_skills(release_id, skill_code)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT skill_catalog_skill_code_safe CHECK (
    skill_code ~ '^(SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
  ),
  CONSTRAINT skill_catalog_skill_slug_safe CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 100
  ),
  CONSTRAINT skill_catalog_skill_label_safe CHECK (
    label_sk = btrim(label_sk) AND length(label_sk) BETWEEN 2 AND 120
      AND craftsman_capability_public_text_safe(label_sk)
  ),
  CONSTRAINT skill_catalog_skill_replacement_consistent CHECK (
    (state = 'ACTIVE' AND replaced_by_code IS NULL)
    OR (
      state = 'DEPRECATED'
      AND replaced_by_code IS NOT NULL
      AND replaced_by_code <> skill_code
    )
  )
);

CREATE TABLE skill_catalog_skill_professions (
  release_id uuid NOT NULL,
  skill_code text NOT NULL,
  profession_taxonomy_release_id uuid NOT NULL,
  profession_code text NOT NULL,
  PRIMARY KEY (release_id, skill_code, profession_code),
  FOREIGN KEY (release_id, skill_code)
    REFERENCES skill_catalog_skills(release_id, skill_code) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, profession_taxonomy_release_id)
    REFERENCES skill_catalog_releases(release_id, profession_taxonomy_release_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (profession_taxonomy_release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code)
    ON DELETE RESTRICT
);

CREATE TABLE skill_catalog_activation_events (
  activation_id uuid PRIMARY KEY,
  activation_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  release_id uuid NOT NULL UNIQUE
    REFERENCES skill_catalog_releases(release_id) ON DELETE RESTRICT,
  previous_release_id uuid
    REFERENCES skill_catalog_releases(release_id) ON DELETE RESTRICT,
  actor_reference text NOT NULL,
  review_reference text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT skill_catalog_activation_actor_safe CHECK (
    actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
  ),
  CONSTRAINT skill_catalog_activation_review_safe CHECK (
    review_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
  ),
  CONSTRAINT skill_catalog_activation_not_self_previous CHECK (
    previous_release_id IS NULL OR previous_release_id <> release_id
  )
);

CREATE FUNCTION enforce_skill_catalog_release_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor_version integer;
BEGIN
  IF NEW.version = 1 THEN RETURN NEW; END IF;
  SELECT version INTO predecessor_version
  FROM skill_catalog_releases WHERE release_id = NEW.supersedes_release_id;
  IF predecessor_version IS DISTINCT FROM NEW.version - 1 THEN
    RAISE EXCEPTION 'skill catalog must supersede the immediately preceding version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_catalog_release_chain_guard
BEFORE INSERT ON skill_catalog_releases
FOR EACH ROW EXECUTE FUNCTION enforce_skill_catalog_release_chain();

CREATE FUNCTION enforce_skill_catalog_install_transaction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release_txid bigint;
BEGIN
  SELECT installation_txid INTO release_txid
  FROM skill_catalog_releases WHERE release_id = NEW.release_id;
  IF release_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'skill catalog release content is sealed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_catalog_skills_install_guard
BEFORE INSERT ON skill_catalog_skills
FOR EACH ROW EXECUTE FUNCTION enforce_skill_catalog_install_transaction();
CREATE TRIGGER skill_catalog_professions_install_guard
BEFORE INSERT ON skill_catalog_skill_professions
FOR EACH ROW EXECUTE FUNCTION enforce_skill_catalog_install_transaction();

CREATE FUNCTION ensure_skill_catalog_skill_has_profession()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM skill_catalog_skill_professions relation
    WHERE relation.release_id = NEW.release_id
      AND relation.skill_code = NEW.skill_code
  ) THEN
    RAISE EXCEPTION 'catalog skill requires at least one relevant profession';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER skill_catalog_skill_profession_required
AFTER INSERT ON skill_catalog_skills
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_skill_catalog_skill_has_profession();

CREATE FUNCTION skill_catalog_has_replacement_cycle(candidate_release_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE skill_walk AS (
    SELECT skill_code AS start_code, replaced_by_code AS current_code,
      ARRAY[skill_code] AS path, false AS cycle
    FROM skill_catalog_skills WHERE release_id = candidate_release_id
    UNION ALL
    SELECT walk.start_code, next.replaced_by_code,
      walk.path || next.skill_code, next.skill_code = ANY(walk.path)
    FROM skill_walk walk
    JOIN skill_catalog_skills next
      ON next.release_id = candidate_release_id
      AND next.skill_code = walk.current_code
    WHERE walk.current_code IS NOT NULL AND NOT walk.cycle
  )
  SELECT EXISTS (SELECT 1 FROM skill_walk WHERE cycle)
$$;

CREATE FUNCTION enforce_skill_catalog_activation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_catalog_id uuid;
  current_version integer;
  current_profession_release_id uuid;
  candidate skill_catalog_releases%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(1301002);
  NEW.occurred_at := clock_timestamp();
  SELECT release_id INTO current_catalog_id
  FROM skill_catalog_activation_events
  ORDER BY activation_sequence DESC LIMIT 1;
  IF NEW.previous_release_id IS DISTINCT FROM current_catalog_id THEN
    RAISE EXCEPTION 'stale skill catalog activation';
  END IF;
  SELECT * INTO candidate FROM skill_catalog_releases
  WHERE release_id = NEW.release_id;
  IF candidate.release_id IS NULL
    OR candidate.content_class <> 'CANONICAL'
    OR candidate.review_state <> 'HUMAN_REVIEW_APPROVED'
    OR candidate.review_reference IS DISTINCT FROM NEW.review_reference
  THEN
    RAISE EXCEPTION 'skill catalog lacks approved canonical governance';
  END IF;
  SELECT release_id INTO current_profession_release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC LIMIT 1;
  IF candidate.profession_taxonomy_release_id IS DISTINCT FROM current_profession_release_id THEN
    RAISE EXCEPTION 'skill catalog profession taxonomy is not current';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM skill_catalog_skills skill
    JOIN skill_catalog_skill_professions relation
      ON relation.release_id = skill.release_id
      AND relation.skill_code = skill.skill_code
    WHERE skill.release_id = NEW.release_id AND skill.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'canonical skill catalog must contain a profession-linked skill';
  END IF;
  IF current_catalog_id IS NOT NULL THEN
    SELECT version INTO current_version FROM skill_catalog_releases
    WHERE release_id = current_catalog_id;
    IF candidate.version <= current_version THEN
      RAISE EXCEPTION 'skill catalog activation version must advance';
    END IF;
  END IF;
  IF skill_catalog_has_replacement_cycle(NEW.release_id) THEN
    RAISE EXCEPTION 'skill catalog replacement cycle is forbidden';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER skill_catalog_activation_guard
BEFORE INSERT ON skill_catalog_activation_events
FOR EACH ROW EXECUTE FUNCTION enforce_skill_catalog_activation();

CREATE FUNCTION reject_skill_catalog_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'skill catalog history is append-only'; END;
$$;
CREATE TRIGGER skill_catalog_releases_immutable
BEFORE UPDATE OR DELETE ON skill_catalog_releases
FOR EACH ROW EXECUTE FUNCTION reject_skill_catalog_mutation();
CREATE TRIGGER skill_catalog_skills_immutable
BEFORE UPDATE OR DELETE ON skill_catalog_skills
FOR EACH ROW EXECUTE FUNCTION reject_skill_catalog_mutation();
CREATE TRIGGER skill_catalog_skill_professions_immutable
BEFORE UPDATE OR DELETE ON skill_catalog_skill_professions
FOR EACH ROW EXECUTE FUNCTION reject_skill_catalog_mutation();
CREATE TRIGGER skill_catalog_activations_immutable
BEFORE UPDATE OR DELETE ON skill_catalog_activation_events
FOR EACH ROW EXECUTE FUNCTION reject_skill_catalog_mutation();

CREATE VIEW current_skill_catalog AS
WITH current_release AS (
  SELECT release_id FROM skill_catalog_activation_events
  ORDER BY activation_sequence DESC LIMIT 1
)
SELECT skill.*, release.version AS release_version,
  release.profession_taxonomy_release_id
FROM skill_catalog_skills skill
JOIN current_release current ON current.release_id = skill.release_id
JOIN skill_catalog_releases release ON release.release_id = skill.release_id;

CREATE VIEW current_skill_catalog_professions AS
WITH current_release AS (
  SELECT release_id FROM skill_catalog_activation_events
  ORDER BY activation_sequence DESC LIMIT 1
)
SELECT relation.*
FROM skill_catalog_skill_professions relation
JOIN current_release current ON current.release_id = relation.release_id;

CREATE TABLE craftsman_specializations (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid NOT NULL REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  taxonomy_release_id uuid NOT NULL,
  specialization_code text NOT NULL,
  state craftsman_capability_state NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deactivated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at timestamptz,
  FOREIGN KEY (taxonomy_release_id, specialization_code)
    REFERENCES taxonomy_specializations(release_id, specialization_code) ON DELETE RESTRICT,
  CONSTRAINT craftsman_specialization_state_consistent CHECK (
    (state = 'ACTIVE' AND deactivated_by_user_id IS NULL
      AND deactivation_command_id IS NULL AND deactivated_at IS NULL)
    OR (state = 'INACTIVE' AND deactivated_by_user_id IS NOT NULL
      AND deactivation_command_id IS NOT NULL AND deactivated_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX craftsman_specializations_one_active
ON craftsman_specializations (craftsman_profile_id, specialization_code)
WHERE state = 'ACTIVE';

CREATE TABLE craftsman_specialization_commands (
  command_id uuid PRIMARY KEY,
  command_kind craftsman_specialization_command_kind NOT NULL,
  craftsman_specialization_id uuid NOT NULL REFERENCES craftsman_specializations(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX craftsman_specialization_one_add_command
ON craftsman_specialization_commands (craftsman_specialization_id)
WHERE command_kind = 'ADD';
CREATE UNIQUE INDEX craftsman_specialization_one_deactivate_command
ON craftsman_specialization_commands (craftsman_specialization_id)
WHERE command_kind = 'DEACTIVATE';
ALTER TABLE craftsman_specializations
ADD CONSTRAINT craftsman_specializations_deactivation_command_fkey
FOREIGN KEY (deactivation_command_id)
REFERENCES craftsman_specialization_commands(command_id) ON DELETE RESTRICT;

CREATE TABLE craftsman_skills (
  id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  identity_kind craftsman_skill_identity_kind NOT NULL,
  skill_catalog_release_id uuid,
  canonical_skill_code text,
  retained_custom_text text,
  state craftsman_capability_state NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deactivated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  deactivation_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at timestamptz,
  FOREIGN KEY (skill_catalog_release_id, canonical_skill_code)
    REFERENCES skill_catalog_skills(release_id, skill_code) ON DELETE RESTRICT,
  CONSTRAINT craftsman_skill_identity_consistent CHECK (
    (identity_kind = 'CANONICAL' AND skill_catalog_release_id IS NOT NULL
      AND canonical_skill_code IS NOT NULL AND retained_custom_text IS NULL)
    OR (identity_kind = 'CUSTOM' AND skill_catalog_release_id IS NULL
      AND canonical_skill_code IS NULL AND retained_custom_text IS NOT NULL
      AND retained_custom_text = btrim(retained_custom_text)
      AND length(retained_custom_text) BETWEEN 2 AND 160
      AND craftsman_capability_public_text_safe(retained_custom_text))
  ),
  CONSTRAINT craftsman_skill_state_consistent CHECK (
    (state = 'ACTIVE' AND deactivated_by_user_id IS NULL
      AND deactivation_command_id IS NULL AND deactivated_at IS NULL)
    OR (state = 'INACTIVE' AND deactivated_by_user_id IS NOT NULL
      AND deactivation_command_id IS NOT NULL AND deactivated_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX craftsman_skills_one_active_canonical
ON craftsman_skills (craftsman_profile_id, skill_catalog_release_id, canonical_skill_code)
WHERE state = 'ACTIVE' AND identity_kind = 'CANONICAL';
CREATE UNIQUE INDEX craftsman_skills_one_active_custom_exact
ON craftsman_skills (craftsman_profile_id, retained_custom_text)
WHERE state = 'ACTIVE' AND identity_kind = 'CUSTOM';

CREATE TABLE craftsman_skill_profession_links (
  craftsman_skill_id uuid NOT NULL REFERENCES craftsman_skills(id) ON DELETE RESTRICT,
  craftsman_profession_id uuid NOT NULL REFERENCES craftsman_professions(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (craftsman_skill_id, craftsman_profession_id)
);

CREATE TABLE craftsman_skill_commands (
  command_id uuid PRIMARY KEY,
  command_kind craftsman_skill_command_kind NOT NULL,
  craftsman_skill_id uuid NOT NULL REFERENCES craftsman_skills(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX craftsman_skill_one_add_command
ON craftsman_skill_commands (craftsman_skill_id) WHERE command_kind = 'ADD';
CREATE UNIQUE INDEX craftsman_skill_one_deactivate_command
ON craftsman_skill_commands (craftsman_skill_id) WHERE command_kind = 'DEACTIVATE';
ALTER TABLE craftsman_skills
ADD CONSTRAINT craftsman_skills_deactivation_command_fkey
FOREIGN KEY (deactivation_command_id)
REFERENCES craftsman_skill_commands(command_id) ON DELETE RESTRICT;

CREATE TABLE craftsman_custom_skill_mapping_events (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE REFERENCES craftsman_skill_commands(command_id) ON DELETE RESTRICT,
  craftsman_skill_id uuid NOT NULL REFERENCES craftsman_skills(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  skill_catalog_release_id uuid NOT NULL,
  canonical_skill_code text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (craftsman_skill_id, revision),
  FOREIGN KEY (skill_catalog_release_id, canonical_skill_code)
    REFERENCES skill_catalog_skills(release_id, skill_code) ON DELETE RESTRICT
);

CREATE FUNCTION lock_active_capability_owner(candidate_profile_id uuid, candidate_actor_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; owner_state user_account_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state INTO owner_id, owner_state
  FROM craftsman_profiles profile JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = candidate_profile_id FOR UPDATE OF profile, owner;
  IF owner_id IS NULL OR owner_id IS DISTINCT FROM candidate_actor_id OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active craftsman profile owner required';
  END IF;
END;
$$;

CREATE FUNCTION enforce_craftsman_specialization_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assignment craftsman_professions%ROWTYPE; specialization taxonomy_specializations%ROWTYPE;
BEGIN
  PERFORM lock_active_capability_owner(NEW.craftsman_profile_id, NEW.created_by_user_id);
  SELECT * INTO assignment FROM craftsman_professions WHERE id = NEW.craftsman_profession_id FOR UPDATE;
  IF assignment.id IS NULL OR assignment.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR assignment.state <> 'ACTIVE' OR assignment.taxonomy_release_id IS DISTINCT FROM NEW.taxonomy_release_id THEN
    RAISE EXCEPTION 'active relevant craftsman profession required';
  END IF;
  SELECT item.* INTO specialization
  FROM taxonomy_specializations item
  JOIN profession_taxonomy_releases release ON release.release_id = item.release_id
  WHERE item.release_id = NEW.taxonomy_release_id
    AND item.specialization_code = NEW.specialization_code
    AND item.profession_code = assignment.profession_code
    AND item.state = 'ACTIVE' AND release.content_class = 'CANONICAL'
    AND release.review_state = 'HUMAN_REVIEW_APPROVED';
  IF specialization.specialization_code IS NULL THEN
    RAISE EXCEPTION 'active relevant governed specialization required';
  END IF;
  IF NEW.state <> 'ACTIVE' OR NEW.deactivated_by_user_id IS NOT NULL
    OR NEW.deactivation_command_id IS NOT NULL OR NEW.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'craftsman specialization must start ACTIVE';
  END IF;
  NEW.created_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_specialization_insert_guard
BEFORE INSERT ON craftsman_specializations
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_specialization_insert();

CREATE FUNCTION enforce_craftsman_skill_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_active_capability_owner(NEW.craftsman_profile_id, NEW.created_by_user_id);
  IF NEW.state <> 'ACTIVE' OR NEW.deactivated_by_user_id IS NOT NULL
    OR NEW.deactivation_command_id IS NOT NULL OR NEW.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'craftsman skill must start ACTIVE';
  END IF;
  IF NEW.identity_kind = 'CANONICAL' AND NOT EXISTS (
    SELECT 1 FROM current_skill_catalog skill
    WHERE skill.release_id = NEW.skill_catalog_release_id
      AND skill.skill_code = NEW.canonical_skill_code
      AND skill.state = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'active governed skill required'; END IF;
  NEW.created_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_skill_insert_guard
BEFORE INSERT ON craftsman_skills
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_skill_insert();

CREATE FUNCTION enforce_craftsman_skill_profession_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim craftsman_skills%ROWTYPE; assignment craftsman_professions%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM craftsman_skills WHERE id = NEW.craftsman_skill_id FOR UPDATE;
  SELECT * INTO assignment FROM craftsman_professions WHERE id = NEW.craftsman_profession_id FOR UPDATE;
  IF claim.id IS NULL OR assignment.id IS NULL
    OR claim.craftsman_profile_id IS DISTINCT FROM assignment.craftsman_profile_id
    OR assignment.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active owned profession is required for skill';
  END IF;
  IF claim.identity_kind = 'CANONICAL' AND NOT EXISTS (
    SELECT 1 FROM current_skill_catalog_professions relation
    WHERE relation.release_id = claim.skill_catalog_release_id
      AND relation.skill_code = claim.canonical_skill_code
      AND relation.profession_taxonomy_release_id = assignment.taxonomy_release_id
      AND relation.profession_code = assignment.profession_code
  ) THEN RAISE EXCEPTION 'canonical skill is not relevant to profession'; END IF;
  NEW.linked_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_skill_profession_link_guard
BEFORE INSERT ON craftsman_skill_profession_links
FOR EACH ROW EXECUTE FUNCTION enforce_craftsman_skill_profession_link();

CREATE FUNCTION enforce_custom_skill_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim craftsman_skills%ROWTYPE; command craftsman_skill_commands%ROWTYPE; current_revision integer;
BEGIN
  SELECT * INTO claim FROM craftsman_skills WHERE id = NEW.craftsman_skill_id FOR UPDATE;
  SELECT * INTO command FROM craftsman_skill_commands WHERE command_id = NEW.command_id;
  IF claim.id IS NULL OR claim.identity_kind <> 'CUSTOM' OR claim.state <> 'ACTIVE'
    OR command.command_id IS NULL OR command.command_kind <> 'MAP_CUSTOM'
    OR command.craftsman_skill_id IS DISTINCT FROM claim.id
    OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'custom skill mapping command mismatch';
  END IF;
  SELECT max(revision) INTO current_revision FROM craftsman_custom_skill_mapping_events
  WHERE craftsman_skill_id = claim.id;
  IF NEW.revision <> COALESCE(current_revision, 0) + 1 THEN
    RAISE EXCEPTION 'custom skill mapping revisions must be contiguous';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM current_skill_catalog skill
    WHERE skill.release_id = NEW.skill_catalog_release_id
      AND skill.skill_code = NEW.canonical_skill_code AND skill.state = 'ACTIVE'
  ) OR EXISTS (
    SELECT 1
    FROM craftsman_skill_profession_links link
    JOIN craftsman_professions assignment ON assignment.id = link.craftsman_profession_id
    WHERE link.craftsman_skill_id = claim.id AND NOT EXISTS (
      SELECT 1 FROM current_skill_catalog_professions relation
      WHERE relation.release_id = NEW.skill_catalog_release_id
        AND relation.skill_code = NEW.canonical_skill_code
        AND relation.profession_taxonomy_release_id = assignment.taxonomy_release_id
        AND relation.profession_code = assignment.profession_code
    )
  ) THEN RAISE EXCEPTION 'mapped canonical skill is not active and relevant'; END IF;
  NEW.occurred_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_custom_skill_mapping_guard
BEFORE INSERT ON craftsman_custom_skill_mapping_events
FOR EACH ROW EXECUTE FUNCTION enforce_custom_skill_mapping();

CREATE FUNCTION enforce_specialization_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim craftsman_specializations%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO claim FROM craftsman_specializations WHERE id = NEW.craftsman_specialization_id FOR UPDATE;
  IF claim.id IS NULL OR claim.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id THEN
    RAISE EXCEPTION 'specialization command target mismatch'; END IF;
  PERFORM lock_active_capability_owner(NEW.craftsman_profile_id, NEW.actor_user_id);
  IF claim.state <> 'ACTIVE' THEN RAISE EXCEPTION 'specialization is not active'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_specialization_command_guard
BEFORE INSERT ON craftsman_specialization_commands
FOR EACH ROW EXECUTE FUNCTION enforce_specialization_command();

CREATE FUNCTION enforce_skill_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim craftsman_skills%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO claim FROM craftsman_skills WHERE id = NEW.craftsman_skill_id FOR UPDATE;
  IF claim.id IS NULL OR claim.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id THEN
    RAISE EXCEPTION 'skill command target mismatch'; END IF;
  PERFORM lock_active_capability_owner(NEW.craftsman_profile_id, NEW.actor_user_id);
  IF claim.state <> 'ACTIVE' THEN RAISE EXCEPTION 'skill is not active'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_skill_command_guard
BEFORE INSERT ON craftsman_skill_commands
FOR EACH ROW EXECUTE FUNCTION enforce_skill_command();

CREATE FUNCTION enforce_specialization_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command craftsman_specialization_commands%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.craftsman_profession_id IS DISTINCT FROM OLD.craftsman_profession_id
    OR NEW.taxonomy_release_id IS DISTINCT FROM OLD.taxonomy_release_id
    OR NEW.specialization_code IS DISTINCT FROM OLD.specialization_code
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.state <> 'ACTIVE' OR NEW.state <> 'INACTIVE' THEN
    RAISE EXCEPTION 'invalid specialization history mutation'; END IF;
  SELECT * INTO command FROM craftsman_specialization_commands WHERE command_id = NEW.deactivation_command_id;
  IF command.command_id IS NULL OR command.command_kind <> 'DEACTIVATE'
    OR command.craftsman_specialization_id IS DISTINCT FROM OLD.id
    OR command.actor_user_id IS DISTINCT FROM NEW.deactivated_by_user_id THEN
    RAISE EXCEPTION 'specialization deactivation requires command provenance'; END IF;
  NEW.deactivated_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_specialization_update_guard
BEFORE UPDATE ON craftsman_specializations
FOR EACH ROW EXECUTE FUNCTION enforce_specialization_update();

CREATE FUNCTION enforce_skill_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command craftsman_skill_commands%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.identity_kind IS DISTINCT FROM OLD.identity_kind
    OR NEW.skill_catalog_release_id IS DISTINCT FROM OLD.skill_catalog_release_id
    OR NEW.canonical_skill_code IS DISTINCT FROM OLD.canonical_skill_code
    OR NEW.retained_custom_text IS DISTINCT FROM OLD.retained_custom_text
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.state <> 'ACTIVE' OR NEW.state <> 'INACTIVE' THEN
    RAISE EXCEPTION 'invalid skill history mutation'; END IF;
  SELECT * INTO command FROM craftsman_skill_commands WHERE command_id = NEW.deactivation_command_id;
  IF command.command_id IS NULL OR command.command_kind <> 'DEACTIVATE'
    OR command.craftsman_skill_id IS DISTINCT FROM OLD.id
    OR command.actor_user_id IS DISTINCT FROM NEW.deactivated_by_user_id THEN
    RAISE EXCEPTION 'skill deactivation requires command provenance'; END IF;
  NEW.deactivated_at := clock_timestamp(); RETURN NEW;
END;
$$;
CREATE TRIGGER craftsman_skill_update_guard
BEFORE UPDATE ON craftsman_skills
FOR EACH ROW EXECUTE FUNCTION enforce_skill_update();

CREATE FUNCTION ensure_specialization_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_kind = 'ADD' AND NOT EXISTS (
    SELECT 1 FROM craftsman_specializations claim
    WHERE claim.id = NEW.craftsman_specialization_id AND claim.state = 'ACTIVE'
  ) THEN RAISE EXCEPTION 'specialization add command requires an active claim';
  ELSIF NEW.command_kind = 'DEACTIVATE' AND NOT EXISTS (
    SELECT 1 FROM craftsman_specializations claim
    WHERE claim.id = NEW.craftsman_specialization_id AND claim.state = 'INACTIVE'
      AND claim.deactivation_command_id = NEW.command_id
  ) THEN RAISE EXCEPTION 'specialization deactivation command requires an inactive claim'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER craftsman_specialization_command_effect_required
AFTER INSERT ON craftsman_specialization_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_specialization_command_effect();

CREATE FUNCTION ensure_specialization_initial_command()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM craftsman_specialization_commands command
    WHERE command.craftsman_specialization_id = NEW.id AND command.command_kind = 'ADD') THEN
    RAISE EXCEPTION 'specialization requires add command provenance'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER craftsman_specialization_initial_command_required
AFTER INSERT ON craftsman_specializations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_specialization_initial_command();

CREATE FUNCTION ensure_skill_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_kind = 'ADD' AND NOT EXISTS (
    SELECT 1 FROM craftsman_skills claim
    WHERE claim.id = NEW.craftsman_skill_id AND claim.state = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM craftsman_skill_profession_links link
        WHERE link.craftsman_skill_id = claim.id)
  ) THEN RAISE EXCEPTION 'skill add command requires an active linked claim';
  ELSIF NEW.command_kind = 'MAP_CUSTOM' AND NOT EXISTS (
    SELECT 1 FROM craftsman_custom_skill_mapping_events event
    WHERE event.command_id = NEW.command_id
  ) THEN RAISE EXCEPTION 'custom skill mapping command requires an event';
  ELSIF NEW.command_kind = 'DEACTIVATE' AND NOT EXISTS (
    SELECT 1 FROM craftsman_skills claim
    WHERE claim.id = NEW.craftsman_skill_id AND claim.state = 'INACTIVE'
      AND claim.deactivation_command_id = NEW.command_id
  ) THEN RAISE EXCEPTION 'skill deactivation command requires an inactive claim'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER craftsman_skill_command_effect_required
AFTER INSERT ON craftsman_skill_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_skill_command_effect();

CREATE FUNCTION ensure_skill_initial_command()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM craftsman_skill_commands command
    WHERE command.craftsman_skill_id = NEW.id AND command.command_kind = 'ADD') THEN
    RAISE EXCEPTION 'skill requires add command provenance'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER craftsman_skill_initial_command_required
AFTER INSERT ON craftsman_skills DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_skill_initial_command();

CREATE FUNCTION reject_craftsman_capability_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'craftsman capability history is append-only'; END;
$$;
CREATE TRIGGER craftsman_specializations_no_delete BEFORE DELETE ON craftsman_specializations
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_specialization_commands_immutable BEFORE UPDATE OR DELETE ON craftsman_specialization_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_skills_no_delete BEFORE DELETE ON craftsman_skills
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_skill_links_immutable BEFORE UPDATE OR DELETE ON craftsman_skill_profession_links
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_skill_commands_immutable BEFORE UPDATE OR DELETE ON craftsman_skill_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER craftsman_skill_mapping_events_immutable BEFORE UPDATE OR DELETE ON craftsman_custom_skill_mapping_events
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();

CREATE VIEW current_craftsman_specializations AS
SELECT claim.id, claim.craftsman_profile_id, claim.craftsman_profession_id,
  claim.taxonomy_release_id, claim.specialization_code, claim.state,
  'CRAFTSMAN'::text AS declaration_source,
  NULL::timestamptz AS evidence_supported_at,
  claim.created_at, claim.deactivated_at
FROM craftsman_specializations claim;

CREATE VIEW current_craftsman_skills AS
SELECT claim.id, claim.craftsman_profile_id, claim.identity_kind,
  claim.skill_catalog_release_id, claim.canonical_skill_code,
  claim.retained_custom_text, mapping.skill_catalog_release_id AS mapped_skill_catalog_release_id,
  mapping.canonical_skill_code AS mapped_canonical_skill_code,
  COALESCE(mapping.revision, 0) AS mapping_revision,
  links.profession_ids, claim.state,
  'CRAFTSMAN'::text AS declaration_source,
  NULL::timestamptz AS evidence_supported_at,
  'NONE'::text AS ranking_signal,
  claim.created_at, claim.deactivated_at
FROM craftsman_skills claim
JOIN LATERAL (
  SELECT array_agg(link.craftsman_profession_id ORDER BY link.craftsman_profession_id) AS profession_ids
  FROM craftsman_skill_profession_links link WHERE link.craftsman_skill_id = claim.id
) links ON true
LEFT JOIN LATERAL (
  SELECT event.skill_catalog_release_id, event.canonical_skill_code, event.revision
  FROM craftsman_custom_skill_mapping_events event
  WHERE event.craftsman_skill_id = claim.id ORDER BY event.revision DESC LIMIT 1
) mapping ON true;

COMMENT ON VIEW current_craftsman_skills IS
  'Self-declared skills have no proficiency level, quantity score, or owner-writable evidence. Custom text is retained after append-only canonical mapping.';
