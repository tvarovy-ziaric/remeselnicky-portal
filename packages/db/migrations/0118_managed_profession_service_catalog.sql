CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE taxonomy_professions
ADD COLUMN description_sk text;

ALTER TABLE taxonomy_professions
ADD CONSTRAINT taxonomy_profession_description_safe CHECK (
  description_sk IS NULL OR (
    description_sk = btrim(description_sk)
    AND length(description_sk) BETWEEN 4 AND 500
    AND description_sk !~ '[\r\n]'
  )
);

CREATE TABLE taxonomy_services (
  release_id uuid NOT NULL
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  service_code text NOT NULL,
  slug text NOT NULL,
  label_sk text NOT NULL,
  description_sk text,
  state taxonomy_entry_state NOT NULL,
  replaced_by_code text,
  PRIMARY KEY (release_id, service_code),
  UNIQUE (release_id, slug),
  FOREIGN KEY (release_id, replaced_by_code)
    REFERENCES taxonomy_services(release_id, service_code)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT taxonomy_service_code_safe CHECK (
    service_code ~ '^(SERV|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
  ),
  CONSTRAINT taxonomy_service_slug_safe CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 100
  ),
  CONSTRAINT taxonomy_service_label_safe CHECK (
    label_sk = btrim(label_sk) AND length(label_sk) BETWEEN 2 AND 120
      AND label_sk !~ '[\r\n]'
  ),
  CONSTRAINT taxonomy_service_description_safe CHECK (
    description_sk IS NULL OR (
      description_sk = btrim(description_sk)
      AND length(description_sk) BETWEEN 4 AND 500
      AND description_sk !~ '[\r\n]'
    )
  ),
  CONSTRAINT taxonomy_service_replacement_consistent CHECK (
    (state = 'ACTIVE' AND replaced_by_code IS NULL)
    OR (
      state = 'DEPRECATED'
      AND replaced_by_code IS NOT NULL
      AND replaced_by_code <> service_code
    )
  )
);

CREATE TABLE taxonomy_service_professions (
  release_id uuid NOT NULL,
  service_code text NOT NULL,
  profession_code text NOT NULL,
  PRIMARY KEY (release_id, service_code, profession_code),
  FOREIGN KEY (release_id, service_code)
    REFERENCES taxonomy_services(release_id, service_code) ON DELETE RESTRICT,
  FOREIGN KEY (release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code) ON DELETE RESTRICT
);

ALTER TABLE taxonomy_aliases DROP CONSTRAINT taxonomy_aliases_pkey;
ALTER TABLE taxonomy_aliases ADD PRIMARY KEY (
  release_id, alias_kind, alias, target_kind, target_code
);

CREATE FUNCTION portal_taxonomy_normalize(candidate text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(regexp_replace(
    translate(
      lower(candidate),
      'áäčďéěíĺľňóôŕřšťúůýž',
      'aacdeeillnoorrstuuyz'
    ),
    '[^a-z0-9]+', ' ', 'g'
  ))
$$;

CREATE INDEX taxonomy_professions_active_kind_label_idx
ON taxonomy_professions (release_id, state, profession_code);
CREATE INDEX taxonomy_professions_normalized_label_trgm_idx
ON taxonomy_professions USING gin (
  portal_taxonomy_normalize(label_sk) gin_trgm_ops
);
CREATE INDEX taxonomy_services_active_kind_label_idx
ON taxonomy_services (release_id, state, service_code);
CREATE INDEX taxonomy_services_normalized_label_trgm_idx
ON taxonomy_services USING gin (
  portal_taxonomy_normalize(label_sk) gin_trgm_ops
);
CREATE INDEX taxonomy_aliases_normalized_alias_trgm_idx
ON taxonomy_aliases USING gin (
  portal_taxonomy_normalize(alias) gin_trgm_ops
);
CREATE INDEX taxonomy_aliases_release_target_idx
ON taxonomy_aliases (release_id, target_kind, target_code);
CREATE INDEX taxonomy_service_professions_profession_idx
ON taxonomy_service_professions (release_id, profession_code, service_code);

CREATE TRIGGER taxonomy_services_install_guard
BEFORE INSERT ON taxonomy_services
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_install_transaction();
CREATE TRIGGER taxonomy_service_professions_install_guard
BEFORE INSERT ON taxonomy_service_professions
FOR EACH ROW EXECUTE FUNCTION enforce_taxonomy_install_transaction();

CREATE OR REPLACE FUNCTION validate_taxonomy_alias_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM taxonomy_professions
    WHERE release_id = NEW.release_id AND slug = NEW.alias
    UNION ALL
    SELECT 1 FROM taxonomy_services
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
  ELSIF NEW.target_kind = 'SERVICE' AND NOT EXISTS (
    SELECT 1 FROM taxonomy_services
    WHERE release_id = NEW.release_id AND service_code = NEW.target_code
  ) THEN
    RAISE EXCEPTION 'taxonomy alias service target is missing';
  ELSIF NEW.target_kind = 'SPECIALIZATION' AND NOT EXISTS (
    SELECT 1 FROM taxonomy_specializations
    WHERE release_id = NEW.release_id AND specialization_code = NEW.target_code
  ) THEN
    RAISE EXCEPTION 'taxonomy alias specialization target is missing';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION taxonomy_release_has_replacement_cycle(candidate_release_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE profession_walk AS (
    SELECT profession_code AS start_code, replaced_by_code AS current_code,
      ARRAY[profession_code] AS path, false AS cycle
    FROM taxonomy_professions WHERE release_id = candidate_release_id
    UNION ALL
    SELECT walk.start_code, next.replaced_by_code,
      walk.path || next.profession_code,
      next.profession_code = ANY(walk.path)
    FROM profession_walk walk
    JOIN taxonomy_professions next
      ON next.release_id = candidate_release_id
      AND next.profession_code = walk.current_code
    WHERE walk.current_code IS NOT NULL AND NOT walk.cycle
  ), specialization_walk AS (
    SELECT specialization_code AS start_code, replaced_by_code AS current_code,
      ARRAY[specialization_code] AS path, false AS cycle
    FROM taxonomy_specializations WHERE release_id = candidate_release_id
    UNION ALL
    SELECT walk.start_code, next.replaced_by_code,
      walk.path || next.specialization_code,
      next.specialization_code = ANY(walk.path)
    FROM specialization_walk walk
    JOIN taxonomy_specializations next
      ON next.release_id = candidate_release_id
      AND next.specialization_code = walk.current_code
    WHERE walk.current_code IS NOT NULL AND NOT walk.cycle
  ), service_walk AS (
    SELECT service_code AS start_code, replaced_by_code AS current_code,
      ARRAY[service_code] AS path, false AS cycle
    FROM taxonomy_services WHERE release_id = candidate_release_id
    UNION ALL
    SELECT walk.start_code, next.replaced_by_code,
      walk.path || next.service_code,
      next.service_code = ANY(walk.path)
    FROM service_walk walk
    JOIN taxonomy_services next
      ON next.release_id = candidate_release_id
      AND next.service_code = walk.current_code
    WHERE walk.current_code IS NOT NULL AND NOT walk.cycle
  )
  SELECT EXISTS (
    SELECT 1 FROM profession_walk WHERE cycle
    UNION ALL SELECT 1 FROM specialization_walk WHERE cycle
    UNION ALL SELECT 1 FROM service_walk WHERE cycle
  )
$$;

CREATE TRIGGER taxonomy_services_immutable
BEFORE UPDATE OR DELETE ON taxonomy_services
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();
CREATE TRIGGER taxonomy_service_professions_immutable
BEFORE UPDATE OR DELETE ON taxonomy_service_professions
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();

CREATE VIEW current_service_taxonomy AS
WITH current_release AS (
  SELECT release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT service.*, links.profession_codes
FROM taxonomy_services service
JOIN current_release current ON current.release_id = service.release_id
JOIN LATERAL (
  SELECT array_agg(link.profession_code ORDER BY link.profession_code)
    AS profession_codes
  FROM taxonomy_service_professions link
  WHERE link.release_id = service.release_id
    AND link.service_code = service.service_code
) links ON true;
