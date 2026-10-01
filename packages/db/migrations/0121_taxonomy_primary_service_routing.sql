-- A service can map to several professions, but customer routing must never
-- depend on array order. Every service release row therefore has exactly one
-- explicit primary profession before that release can be activated.
DROP TRIGGER taxonomy_service_professions_immutable
ON taxonomy_service_professions;

ALTER TABLE taxonomy_service_professions
ADD COLUMN is_primary boolean NOT NULL DEFAULT false;

WITH primary_links AS (
  SELECT release_id, service_code, min(profession_code) AS profession_code
  FROM taxonomy_service_professions
  GROUP BY release_id, service_code
)
UPDATE taxonomy_service_professions link
SET is_primary = true
FROM primary_links primary_link
WHERE primary_link.release_id = link.release_id
  AND primary_link.service_code = link.service_code
  AND primary_link.profession_code = link.profession_code;

ALTER TABLE taxonomy_service_professions
ALTER COLUMN is_primary DROP DEFAULT;

CREATE UNIQUE INDEX taxonomy_service_professions_one_primary_idx
ON taxonomy_service_professions (release_id, service_code)
WHERE is_primary;

CREATE TRIGGER taxonomy_service_professions_immutable
BEFORE UPDATE OR DELETE ON taxonomy_service_professions
FOR EACH ROW EXECUTE FUNCTION reject_taxonomy_mutation();

CREATE OR REPLACE VIEW current_service_taxonomy AS
WITH current_release AS (
  SELECT release_id
  FROM profession_taxonomy_activation_events
  ORDER BY activation_sequence DESC
  LIMIT 1
)
SELECT service.*, links.profession_codes, links.primary_profession_code
FROM taxonomy_services service
JOIN current_release current ON current.release_id = service.release_id
JOIN LATERAL (
  SELECT
    array_agg(link.profession_code ORDER BY link.profession_code)
      AS profession_codes,
    max(link.profession_code) FILTER (WHERE link.is_primary)
      AS primary_profession_code
  FROM taxonomy_service_professions link
  WHERE link.release_id = service.release_id
    AND link.service_code = service.service_code
) links ON true;

CREATE OR REPLACE FUNCTION enforce_taxonomy_activation()
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
  IF EXISTS (
    SELECT 1
    FROM taxonomy_services service
    LEFT JOIN taxonomy_service_professions link
      ON link.release_id = service.release_id
     AND link.service_code = service.service_code
     AND link.is_primary
    WHERE service.release_id = NEW.release_id
    GROUP BY service.release_id, service.service_code
    HAVING count(link.profession_code) <> 1
  ) THEN
    RAISE EXCEPTION 'taxonomy service must have exactly one primary profession';
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve the complete v1 validator for historical sections and wrap it with
-- the additive v2 service/profession consistency rule.
ALTER FUNCTION job_request_content_section_valid(uuid, text, integer, jsonb)
RENAME TO job_request_content_section_valid_v1;

CREATE FUNCTION job_request_content_section_valid(
  candidate_request_id uuid,
  candidate_section_key text,
  candidate_schema_version integer,
  candidate_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  primary_profession text;
  primary_service text;
BEGIN
  IF candidate_section_key <> 'request.core'
     OR candidate_schema_version = 1 THEN
    RETURN job_request_content_section_valid_v1(
      candidate_request_id,
      candidate_section_key,
      candidate_schema_version,
      candidate_payload
    );
  END IF;

  IF candidate_schema_version <> 2
     OR jsonb_typeof(candidate_payload) <> 'object'
     OR NOT (candidate_payload ? 'primaryServiceCode')
     OR NOT job_request_content_section_valid_v1(
       candidate_request_id,
       candidate_section_key,
       1,
       candidate_payload - 'primaryServiceCode'
     ) THEN
    RETURN false;
  END IF;

  primary_profession := candidate_payload ->> 'primaryProfessionCode';
  IF candidate_payload -> 'primaryServiceCode' = 'null'::jsonb THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(candidate_payload -> 'primaryServiceCode') <> 'string' THEN
    RETURN false;
  END IF;
  primary_service := candidate_payload ->> 'primaryServiceCode';
  IF primary_service !~ '^(SERV|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
     OR primary_profession IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM current_service_taxonomy service
    WHERE service.service_code = primary_service
      AND service.state = 'ACTIVE'
      AND service.primary_profession_code = primary_profession
  );
END;
$$;

CREATE OR REPLACE FUNCTION validate_job_request_content_section()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source job_request_commands%ROWTYPE;
  owner_id uuid;
  asset_id text;
BEGIN
  IF NOT job_request_content_section_valid(
    NEW.job_request_id, NEW.section_key, NEW.section_schema_version, NEW.payload
  ) THEN
    RAISE EXCEPTION 'job request section content is invalid';
  END IF;

  IF NEW.section_key <> 'request.media' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO source FROM job_request_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  SELECT profile.owner_user_id INTO owner_id
  FROM customer_profiles profile
  WHERE profile.id = source.customer_profile_id;

  FOR asset_id IN SELECT jsonb_array_elements_text(
    COALESCE(NEW.payload -> 'photoMediaAssetIds', '[]'::jsonb)
  ) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM media_assets asset
      WHERE asset.id = asset_id::uuid
        AND asset.owner_user_id = owner_id
        AND asset.status = 'READY'
        AND asset.kind = 'IMAGE'
        AND asset.purpose::text = 'JOB_REQUEST_IMAGE'
        AND asset.provenance_entity_type = 'JOB_REQUEST'
        AND asset.provenance_entity_id = NEW.job_request_id
    ) THEN
      RAISE EXCEPTION 'job request photo is unavailable';
    END IF;
  END LOOP;

  FOR asset_id IN SELECT jsonb_array_elements_text(
    COALESCE(NEW.payload -> 'documentMediaAssetIds', '[]'::jsonb)
  ) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM media_assets asset
      WHERE asset.id = asset_id::uuid
        AND asset.owner_user_id = owner_id
        AND asset.status = 'READY'
        AND asset.kind = 'DOCUMENT'
        AND asset.purpose::text = 'JOB_REQUEST_DOCUMENT'
        AND asset.provenance_entity_type = 'JOB_REQUEST'
        AND asset.provenance_entity_id = NEW.job_request_id
    ) THEN
      RAISE EXCEPTION 'job request document is unavailable';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

ALTER TABLE job_request_active_edit_commands
DROP CONSTRAINT job_request_active_edit_section_shape;
ALTER TABLE job_request_active_edit_commands
ADD CONSTRAINT job_request_active_edit_section_shape CHECK (
  section_key IN (
    'request.core', 'request.location', 'request.timing',
    'request.budget', 'request.details', 'request.media'
  )
  AND (
    (section_key = 'request.core' AND section_schema_version IN (1, 2))
    OR (section_key <> 'request.core' AND section_schema_version = 1)
  )
  AND jsonb_typeof(section_payload) = 'object'
  AND octet_length(section_payload::text) <= 34816
  AND section_payload_fingerprint ~ '^[0-9a-f]{64}$'
  AND intent_fingerprint ~ '^[0-9a-f]{64}$'
);

ALTER TABLE job_request_active_section_revisions
DROP CONSTRAINT job_request_active_section_shape;
ALTER TABLE job_request_active_section_revisions
ADD CONSTRAINT job_request_active_section_shape CHECK (
  section_key IN (
    'request.core', 'request.location', 'request.timing',
    'request.budget', 'request.details', 'request.media'
  )
  AND (
    (section_key = 'request.core' AND section_schema_version IN (1, 2))
    OR (section_key <> 'request.core' AND section_schema_version = 1)
  )
  AND jsonb_typeof(payload) = 'object'
  AND octet_length(payload::text) <= 34816
  AND payload_fingerprint ~ '^[0-9a-f]{64}$'
);

CREATE OR REPLACE FUNCTION job_request_classify_active_change(
  candidate_key text,
  previous_payload jsonb,
  next_payload jsonb
)
RETURNS job_request_material_change_category[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE candidate_key
    WHEN 'request.core' THEN ARRAY_REMOVE(ARRAY[
      CASE WHEN previous_payload -> 'primaryProfessionCode'
            IS DISTINCT FROM next_payload -> 'primaryProfessionCode'
          OR COALESCE(previous_payload -> 'primaryServiceCode', 'null'::jsonb)
            IS DISTINCT FROM COALESCE(
              next_payload -> 'primaryServiceCode', 'null'::jsonb
            )
        THEN 'PROFESSION'::job_request_material_change_category END,
      CASE WHEN previous_payload -> 'description'
            IS DISTINCT FROM next_payload -> 'description'
          OR previous_payload -> 'relatedProfessionCodes'
            IS DISTINCT FROM next_payload -> 'relatedProfessionCodes'
          OR previous_payload -> 'skillCodes'
            IS DISTINCT FROM next_payload -> 'skillCodes'
          OR previous_payload -> 'specializationCode'
            IS DISTINCT FROM next_payload -> 'specializationCode'
        THEN 'SCOPE'::job_request_material_change_category END
    ], NULL)
    WHEN 'request.location' THEN
      ARRAY['LOCATION'::job_request_material_change_category]
    WHEN 'request.timing' THEN
      ARRAY['SCHEDULE'::job_request_material_change_category]
    WHEN 'request.budget' THEN
      ARRAY['BUDGET'::job_request_material_change_category]
    WHEN 'request.media' THEN
      ARRAY['ATTACHMENTS'::job_request_material_change_category]
    WHEN 'request.details' THEN ARRAY_REMOVE(ARRAY[
      CASE WHEN previous_payload -> 'materialResponsibility'
          IS DISTINCT FROM next_payload -> 'materialResponsibility'
        THEN 'MATERIAL_RESPONSIBILITY'::job_request_material_change_category END,
      CASE WHEN previous_payload -> 'customRequirements'
          IS DISTINCT FROM next_payload -> 'customRequirements'
        THEN 'OTHER_REQUIREMENTS'::job_request_material_change_category END,
      CASE WHEN previous_payload -> 'approximateQuantity'
            IS DISTINCT FROM next_payload -> 'approximateQuantity'
          OR previous_payload -> 'siteInspection'
            IS DISTINCT FROM next_payload -> 'siteInspection'
        THEN 'SCOPE'::job_request_material_change_category END
    ], NULL)
    ELSE ARRAY[]::job_request_material_change_category[]
  END;
$$;

CREATE OR REPLACE FUNCTION validate_job_request_active_edit_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_lifecycle current_job_requests%ROWTYPE;
  current_content job_request_active_content_revisions%ROWTYPE;
  previous_payload jsonb;
  computed_categories job_request_material_change_category[];
  computed_material boolean;
  expected_visible integer;
  request_customer uuid;
  owner_id uuid;
  owner_state user_account_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO owner_id, owner_state
  FROM customer_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.customer_profile_id
  FOR UPDATE OF owner, profile;
  IF NOT FOUND OR owner_id <> NEW.actor_user_id OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active owning customer required for active request edit';
  END IF;
  SELECT customer_profile_id INTO request_customer FROM job_requests
  WHERE id = NEW.job_request_id FOR UPDATE;
  IF NOT FOUND OR request_customer <> NEW.customer_profile_id THEN
    RAISE EXCEPTION 'owned job request required for active edit';
  END IF;
  SELECT * INTO current_lifecycle FROM current_job_requests
  WHERE id = NEW.job_request_id;
  IF NOT FOUND OR current_lifecycle.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active job request required for edit';
  END IF;
  SELECT * INTO current_content FROM job_request_active_content_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY content_revision DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR current_content.content_revision <> NEW.expected_content_revision THEN
    RAISE EXCEPTION 'active job request edit is stale';
  END IF;
  IF NOT job_request_content_section_valid(
    NEW.job_request_id, NEW.section_key,
    NEW.section_schema_version, NEW.section_payload
  ) OR (NEW.section_key = 'request.media' AND NOT job_request_active_media_available(
    NEW.job_request_id, NEW.customer_profile_id, NEW.section_payload
  )) THEN
    RAISE EXCEPTION 'active job request section is invalid';
  END IF;
  SELECT section.payload INTO previous_payload
  FROM job_request_active_section_revisions section
  WHERE section.job_request_id = NEW.job_request_id
    AND section.section_key = NEW.section_key
    AND section.content_revision <= current_content.content_revision
  ORDER BY section.content_revision DESC LIMIT 1;
  previous_payload := COALESCE(
    previous_payload, job_request_default_section_payload(NEW.section_key)
  );
  IF previous_payload = NEW.section_payload THEN
    IF NEW.result_kind <> 'UNCHANGED'
       OR NEW.resulting_content_revision <> current_content.content_revision
       OR NEW.resulting_visible_version <> current_content.visible_version
       OR NEW.material_change OR cardinality(NEW.change_categories) <> 0 THEN
      RAISE EXCEPTION 'equivalent active edit must be unchanged';
    END IF;
  ELSE
    computed_categories := job_request_classify_active_change(
      NEW.section_key, previous_payload, NEW.section_payload
    );
    computed_material := cardinality(computed_categories) > 0;
    expected_visible := current_content.visible_version
      + CASE WHEN computed_material THEN 1 ELSE 0 END;
    IF NEW.result_kind <> 'APPLIED'
       OR NEW.resulting_content_revision <> current_content.content_revision + 1
       OR NEW.resulting_visible_version <> expected_visible
       OR NEW.material_change <> computed_material
       OR NEW.change_categories <> computed_categories THEN
      RAISE EXCEPTION 'active edit classification/effect is invalid';
    END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_request_missing_submission_requirements(
  candidate_request_id uuid,
  candidate_revision integer
)
RETURNS job_request_submission_requirement[]
LANGUAGE sql
STABLE
AS $$
  WITH content AS (
    SELECT DISTINCT ON (section.section_key)
      section.section_key,
      section.payload
    FROM job_request_draft_section_revisions section
    WHERE section.job_request_id = candidate_request_id
      AND section.request_revision <= candidate_revision
    ORDER BY section.section_key, section.request_revision DESC
  ), core AS (
    SELECT payload FROM content WHERE section_key = 'request.core'
  ), location AS (
    SELECT payload FROM content WHERE section_key = 'request.location'
  )
  SELECT ARRAY_REMOVE(ARRAY[
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM core
      JOIN current_profession_taxonomy profession
        ON profession.profession_code = core.payload ->> 'primaryProfessionCode'
       AND profession.state = 'ACTIVE'
      WHERE core.payload ->> 'primaryServiceCode' IS NULL
        OR EXISTS (
          SELECT 1 FROM current_service_taxonomy service
          WHERE service.service_code = core.payload ->> 'primaryServiceCode'
            AND service.state = 'ACTIVE'
            AND service.primary_profession_code = profession.profession_code
        )
    ) THEN 'PRIMARY_PROFESSION'::job_request_submission_requirement END,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM core
      WHERE length(btrim(core.payload ->> 'description')) BETWEEN 1 AND 4000
    ) THEN 'DESCRIPTION'::job_request_submission_requirement END,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM location
      JOIN location_municipalities municipality
        ON municipality.code = location.payload ->> 'municipalityCode'
       AND municipality.is_active
    ) THEN 'MUNICIPALITY'::job_request_submission_requirement END
  ], NULL);
$$;

COMMENT ON COLUMN taxonomy_service_professions.is_primary IS
  'Exactly one explicit server-authoritative routing profession per service and release.';
COMMENT ON FUNCTION job_request_content_section_valid(uuid, text, integer, jsonb) IS
  'Accepts historical v1 and validates v2 service selection against its explicit current primary profession.';
