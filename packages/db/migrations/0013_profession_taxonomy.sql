CREATE TYPE taxonomy_content_class AS ENUM ('PLACEHOLDER', 'CANONICAL');
CREATE TYPE taxonomy_review_state AS ENUM (
  'HUMAN_REVIEW_PENDING',
  'HUMAN_REVIEW_APPROVED'
);
CREATE TYPE taxonomy_entry_state AS ENUM ('ACTIVE', 'DEPRECATED');
CREATE TYPE taxonomy_capability_level AS ENUM ('ADVANCED', 'MASTER');
CREATE TYPE taxonomy_alias_kind AS ENUM (
  'LEGACY_CODE',
  'LEGACY_SLUG',
  'SEARCH_TERM'
);
CREATE TYPE taxonomy_alias_target_kind AS ENUM ('PROFESSION', 'SPECIALIZATION');

CREATE TABLE profession_taxonomy_releases (
  release_id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  content_class taxonomy_content_class NOT NULL,
  review_state taxonomy_review_state NOT NULL,
  review_reference text,
  supersedes_release_id uuid UNIQUE
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  checksum_sha256 char(64) NOT NULL UNIQUE,
  installation_txid bigint NOT NULL DEFAULT txid_current(),
  installed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT profession_taxonomy_release_chain CHECK (
    (version = 1 AND supersedes_release_id IS NULL)
    OR (version > 1 AND supersedes_release_id IS NOT NULL)
  ),
  CONSTRAINT profession_taxonomy_review_governance CHECK (
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
  CONSTRAINT profession_taxonomy_checksum CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE taxonomy_professions (
  release_id uuid NOT NULL
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  profession_code text NOT NULL,
  slug text NOT NULL,
  label_sk text NOT NULL,
  state taxonomy_entry_state NOT NULL,
  replaced_by_code text,
  PRIMARY KEY (release_id, profession_code),
  UNIQUE (release_id, slug),
  FOREIGN KEY (release_id, replaced_by_code)
    REFERENCES taxonomy_professions(release_id, profession_code)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT taxonomy_profession_code_safe CHECK (
    profession_code ~ '^(PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
  ),
  CONSTRAINT taxonomy_profession_slug_safe CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 100
  ),
  CONSTRAINT taxonomy_profession_label_safe CHECK (
    label_sk = btrim(label_sk) AND length(label_sk) BETWEEN 2 AND 120
      AND label_sk !~ '[\r\n]'
  ),
  CONSTRAINT taxonomy_profession_replacement_consistent CHECK (
    (state = 'ACTIVE' AND replaced_by_code IS NULL)
    OR (
      state = 'DEPRECATED'
      AND replaced_by_code IS NOT NULL
      AND replaced_by_code <> profession_code
    )
  )
);

CREATE TABLE taxonomy_specializations (
  release_id uuid NOT NULL,
  specialization_code text NOT NULL,
  profession_code text NOT NULL,
  slug text NOT NULL,
  label_sk text NOT NULL,
  state taxonomy_entry_state NOT NULL,
  replaced_by_code text,
  PRIMARY KEY (release_id, specialization_code),
  UNIQUE (release_id, slug),
  FOREIGN KEY (release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code)
    ON DELETE RESTRICT,
  FOREIGN KEY (release_id, replaced_by_code)
    REFERENCES taxonomy_specializations(release_id, specialization_code)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT taxonomy_specialization_code_safe CHECK (
    specialization_code ~ '^(SPEC|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
  ),
  CONSTRAINT taxonomy_specialization_slug_safe CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 100
  ),
  CONSTRAINT taxonomy_specialization_label_safe CHECK (
    label_sk = btrim(label_sk) AND length(label_sk) BETWEEN 2 AND 120
      AND label_sk !~ '[\r\n]'
  ),
  CONSTRAINT taxonomy_specialization_replacement_consistent CHECK (
    (state = 'ACTIVE' AND replaced_by_code IS NULL)
    OR (
      state = 'DEPRECATED'
      AND replaced_by_code IS NOT NULL
      AND replaced_by_code <> specialization_code
    )
  )
);

CREATE TABLE taxonomy_capability_criteria (
  release_id uuid NOT NULL,
  criterion_code text NOT NULL,
  profession_code text NOT NULL,
  level taxonomy_capability_level NOT NULL,
  label_sk text NOT NULL,
  description_sk text NOT NULL,
  state taxonomy_entry_state NOT NULL,
  PRIMARY KEY (release_id, criterion_code),
  FOREIGN KEY (release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code)
    ON DELETE RESTRICT,
  CONSTRAINT taxonomy_criterion_code_safe CHECK (
    criterion_code ~ '^(CAP|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
  ),
  CONSTRAINT taxonomy_criterion_label_safe CHECK (
    label_sk = btrim(label_sk) AND length(label_sk) BETWEEN 2 AND 120
      AND label_sk !~ '[\r\n]'
  ),
  CONSTRAINT taxonomy_criterion_description_safe CHECK (
    description_sk = btrim(description_sk)
      AND length(description_sk) BETWEEN 8 AND 500
      AND description_sk !~ '[\r\n]'
  )
);

CREATE TABLE taxonomy_aliases (
  release_id uuid NOT NULL
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  alias text NOT NULL,
  alias_kind taxonomy_alias_kind NOT NULL,
  target_kind taxonomy_alias_target_kind NOT NULL,
  target_code text NOT NULL,
  PRIMARY KEY (release_id, alias_kind, alias),
  CONSTRAINT taxonomy_alias_safe CHECK (
    alias ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(alias) <= 100
  ),
  CONSTRAINT taxonomy_alias_target_code_safe CHECK (
    target_code ~ '^(PROF|SPEC|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
  )
);

CREATE TABLE profession_taxonomy_activation_events (
  activation_id uuid PRIMARY KEY,
  activation_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  release_id uuid NOT NULL UNIQUE
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  previous_release_id uuid
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  actor_reference text NOT NULL,
  review_reference text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT taxonomy_activation_actor_safe CHECK (
    actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
  ),
  CONSTRAINT taxonomy_activation_review_safe CHECK (
    review_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
  ),
  CONSTRAINT taxonomy_activation_not_self_previous CHECK (
    previous_release_id IS NULL OR previous_release_id <> release_id
  )
);

CREATE FUNCTION enforce_taxonomy_release_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor_version integer;
BEGIN
  IF NEW.version = 1 THEN
    RETURN NEW;
  END IF;
  SELECT version INTO predecessor_version
  FROM profession_taxonomy_releases
  WHERE release_id = NEW.supersedes_release_id;
  IF predecessor_version IS DISTINCT FROM NEW.version - 1 THEN
    RAISE EXCEPTION 'taxonomy release must supersede the immediately preceding version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profession_taxonomy_release_chain_guard
BEFORE INSERT ON profession_taxonomy_releases
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_release_chain();

CREATE FUNCTION enforce_taxonomy_install_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_txid bigint;
BEGIN
  SELECT installation_txid INTO release_txid
  FROM profession_taxonomy_releases
  WHERE release_id = NEW.release_id;
  IF release_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'taxonomy release content is sealed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER taxonomy_professions_install_guard
BEFORE INSERT ON taxonomy_professions
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_install_transaction();
CREATE TRIGGER taxonomy_specializations_install_guard
BEFORE INSERT ON taxonomy_specializations
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_install_transaction();
CREATE TRIGGER taxonomy_capability_criteria_install_guard
BEFORE INSERT ON taxonomy_capability_criteria
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_install_transaction();
CREATE TRIGGER taxonomy_aliases_install_guard
BEFORE INSERT ON taxonomy_aliases
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_install_transaction();

CREATE FUNCTION validate_taxonomy_alias_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM taxonomy_professions
    WHERE release_id = NEW.release_id AND slug = NEW.alias
    UNION ALL
    SELECT 1 FROM taxonomy_specializations
    WHERE release_id = NEW.release_id AND slug = NEW.alias
  ) THEN
    RAISE EXCEPTION 'taxonomy alias conflicts with canonical slug';
  END IF;
  IF NEW.target_kind = 'PROFESSION' AND NOT EXISTS (
    SELECT 1 FROM taxonomy_professions
    WHERE release_id = NEW.release_id AND profession_code = NEW.target_code
  ) THEN
    RAISE EXCEPTION 'taxonomy alias profession target is missing';
  ELSIF NEW.target_kind = 'SPECIALIZATION' AND NOT EXISTS (
    SELECT 1 FROM taxonomy_specializations
    WHERE release_id = NEW.release_id AND specialization_code = NEW.target_code
  ) THEN
    RAISE EXCEPTION 'taxonomy alias specialization target is missing';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER taxonomy_alias_target_guard
BEFORE INSERT ON taxonomy_aliases
FOR EACH ROW EXECUTE FUNCTION validate_taxonomy_alias_target();

CREATE FUNCTION taxonomy_release_has_replacement_cycle(candidate_release_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE profession_walk AS (
    SELECT
      profession_code AS start_code,
      replaced_by_code AS current_code,
      ARRAY[profession_code] AS path,
      false AS cycle
    FROM taxonomy_professions
    WHERE release_id = candidate_release_id
    UNION ALL
    SELECT
      walk.start_code,
      next.replaced_by_code,
      walk.path || next.profession_code,
      next.profession_code = ANY(walk.path)
    FROM profession_walk walk
    JOIN taxonomy_professions next
      ON next.release_id = candidate_release_id
      AND next.profession_code = walk.current_code
    WHERE walk.current_code IS NOT NULL AND NOT walk.cycle
  ), specialization_walk AS (
    SELECT
      specialization_code AS start_code,
      replaced_by_code AS current_code,
      ARRAY[specialization_code] AS path,
      false AS cycle
    FROM taxonomy_specializations
    WHERE release_id = candidate_release_id
    UNION ALL
    SELECT
      walk.start_code,
      next.replaced_by_code,
      walk.path || next.specialization_code,
      next.specialization_code = ANY(walk.path)
    FROM specialization_walk walk
    JOIN taxonomy_specializations next
      ON next.release_id = candidate_release_id
      AND next.specialization_code = walk.current_code
    WHERE walk.current_code IS NOT NULL AND NOT walk.cycle
  )
  SELECT EXISTS (
    SELECT 1 FROM profession_walk WHERE cycle
    UNION ALL
    SELECT 1 FROM specialization_walk WHERE cycle
  )
$$;

CREATE FUNCTION enforce_taxonomy_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_release_id uuid;
  current_version integer;
  candidate profession_taxonomy_releases%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(1301001);
  NEW.occurred_at := clock_timestamp();
  SELECT release_id INTO current_release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1;
  IF NEW.previous_release_id IS DISTINCT FROM current_release_id THEN
    RAISE EXCEPTION 'stale taxonomy activation';
  END IF;
  SELECT * INTO candidate
  FROM profession_taxonomy_releases
  WHERE release_id = NEW.release_id;
  IF candidate.content_class <> 'CANONICAL'
    OR candidate.review_state <> 'HUMAN_REVIEW_APPROVED'
    OR candidate.review_reference IS DISTINCT FROM NEW.review_reference
  THEN
    RAISE EXCEPTION 'taxonomy release lacks approved canonical governance';
  END IF;
  IF current_release_id IS NOT NULL THEN
    SELECT version INTO current_version
    FROM profession_taxonomy_releases
    WHERE release_id = current_release_id;
    IF candidate.version <= current_version THEN
      RAISE EXCEPTION 'taxonomy activation version must advance';
    END IF;
  END IF;
  IF taxonomy_release_has_replacement_cycle(NEW.release_id) THEN
    RAISE EXCEPTION 'taxonomy replacement cycle is forbidden';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profession_taxonomy_activation_guard
BEFORE INSERT ON profession_taxonomy_activation_events
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_activation();

CREATE FUNCTION reject_taxonomy_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'taxonomy history is append-only';
END;
$$;

CREATE TRIGGER profession_taxonomy_releases_immutable
BEFORE UPDATE OR DELETE ON profession_taxonomy_releases
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();
CREATE TRIGGER taxonomy_professions_immutable
BEFORE UPDATE OR DELETE ON taxonomy_professions
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();
CREATE TRIGGER taxonomy_specializations_immutable
BEFORE UPDATE OR DELETE ON taxonomy_specializations
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();
CREATE TRIGGER taxonomy_capability_criteria_immutable
BEFORE UPDATE OR DELETE ON taxonomy_capability_criteria
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();
CREATE TRIGGER taxonomy_aliases_immutable
BEFORE UPDATE OR DELETE ON taxonomy_aliases
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();
CREATE TRIGGER profession_taxonomy_activations_immutable
BEFORE UPDATE OR DELETE ON profession_taxonomy_activation_events
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();

CREATE VIEW current_profession_taxonomy AS
WITH current_release AS (
  SELECT release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT
  profession.release_id,
  release.version AS release_version,
  profession.profession_code,
  profession.slug,
  profession.label_sk,
  profession.state,
  profession.replaced_by_code
FROM taxonomy_professions profession
JOIN current_release current ON current.release_id = profession.release_id
JOIN profession_taxonomy_releases release ON release.release_id = profession.release_id;

CREATE VIEW current_specialization_taxonomy AS
WITH current_release AS (
  SELECT release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT specialization.*
FROM taxonomy_specializations specialization
JOIN current_release current ON current.release_id = specialization.release_id;

CREATE VIEW current_profession_capability_criteria AS
WITH current_release AS (
  SELECT release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT criterion.*
FROM taxonomy_capability_criteria criterion
JOIN current_release current ON current.release_id = criterion.release_id;

CREATE VIEW current_taxonomy_aliases AS
WITH current_release AS (
  SELECT release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT alias.*
FROM taxonomy_aliases alias
JOIN current_release current ON current.release_id = alias.release_id;
