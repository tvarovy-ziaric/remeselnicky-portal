ALTER TYPE media_upload_purpose ADD VALUE IF NOT EXISTS 'JOB_REQUEST_DOCUMENT';

CREATE FUNCTION job_request_json_has_only_keys(
  candidate jsonb,
  allowed text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(candidate) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(candidate) key
      WHERE NOT key = ANY(allowed)
    );
$$;

CREATE FUNCTION job_request_optional_trimmed_text_valid(
  candidate jsonb,
  key_name text,
  maximum_length integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT (candidate ? key_name)
    OR candidate -> key_name = 'null'::jsonb
    OR (
      jsonb_typeof(candidate -> key_name) = 'string'
      AND length(btrim(candidate ->> key_name)) BETWEEN 1 AND maximum_length
      AND (candidate ->> key_name) !~ '[[:cntrl:]]'
    );
$$;

CREATE FUNCTION job_request_code_array_valid(
  candidate jsonb,
  key_name text,
  maximum_count integer,
  code_pattern text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT (candidate ? key_name)
    OR (
      jsonb_typeof(candidate -> key_name) = 'array'
      AND jsonb_array_length(candidate -> key_name) <= maximum_count
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(candidate -> key_name) item
        WHERE jsonb_typeof(item) <> 'string'
          OR NOT ((item #>> '{}') ~ code_pattern)
      )
      AND (
        SELECT count(*) = count(DISTINCT item #>> '{}')
        FROM jsonb_array_elements(candidate -> key_name) item
      )
    );
$$;

CREATE FUNCTION job_request_optional_safe_text_valid(
  candidate jsonb,
  key_name text,
  maximum_length integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT job_request_optional_trimmed_text_valid(
    candidate, key_name, maximum_length
  ) AND (
    NOT (candidate ? key_name)
    OR candidate -> key_name = 'null'::jsonb
    OR (
      (candidate ->> key_name) !~* '[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}'
      AND (candidate ->> key_name)
        !~ '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)'
    )
  );
$$;

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
  municipality text;
  budget_mode text;
  timing_mode text;
  latitude numeric;
  longitude numeric;
BEGIN
  IF candidate_schema_version <> 1 OR jsonb_typeof(candidate_payload) <> 'object' THEN
    RETURN false;
  END IF;

  IF candidate_section_key = 'request.core' THEN
    IF NOT job_request_json_has_only_keys(candidate_payload, ARRAY[
      'title', 'primaryProfessionCode', 'relatedProfessionCodes',
      'specializationCode', 'skillCodes', 'description'
    ])
      OR NOT job_request_optional_safe_text_valid(candidate_payload, 'title', 160)
      OR NOT job_request_optional_safe_text_valid(candidate_payload, 'description', 4000)
      OR NOT job_request_code_array_valid(
        candidate_payload, 'relatedProfessionCodes', 32,
        '^(PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
      )
      OR NOT job_request_code_array_valid(
        candidate_payload, 'skillCodes', 128,
        '^(SKILL|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
      ) THEN
      RETURN false;
    END IF;

    IF candidate_payload ? 'primaryProfessionCode'
       AND candidate_payload -> 'primaryProfessionCode' <> 'null'::jsonb THEN
      IF jsonb_typeof(candidate_payload -> 'primaryProfessionCode') <> 'string' THEN
        RETURN false;
      END IF;
      primary_profession := candidate_payload ->> 'primaryProfessionCode';
      IF primary_profession !~ '^(PROF|TEST):[A-Z0-9][A-Z0-9_]{1,62}$'
         OR NOT EXISTS (
           SELECT 1 FROM current_profession_taxonomy profession
           WHERE profession.profession_code = primary_profession
             AND profession.state = 'ACTIVE'
         ) THEN
        RETURN false;
      END IF;
    END IF;

    IF candidate_payload ? 'relatedProfessionCodes' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        candidate_payload -> 'relatedProfessionCodes'
      ) code
      WHERE code = primary_profession
        OR NOT EXISTS (
          SELECT 1 FROM current_profession_taxonomy profession
          WHERE profession.profession_code = code AND profession.state = 'ACTIVE'
        )
    ) THEN
      RETURN false;
    END IF;

    IF candidate_payload ? 'specializationCode'
       AND candidate_payload -> 'specializationCode' <> 'null'::jsonb THEN
      IF jsonb_typeof(candidate_payload -> 'specializationCode') <> 'string'
         OR primary_profession IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM current_specialization_taxonomy specialization
           WHERE specialization.specialization_code =
             candidate_payload ->> 'specializationCode'
             AND specialization.profession_code = primary_profession
             AND specialization.state = 'ACTIVE'
         ) THEN
        RETURN false;
      END IF;
    END IF;

    IF candidate_payload ? 'skillCodes' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(candidate_payload -> 'skillCodes') code
      WHERE primary_profession IS NULL OR NOT EXISTS (
        SELECT 1
        FROM current_skill_catalog skill
        JOIN current_skill_catalog_professions relation
          ON relation.release_id = skill.release_id
          AND relation.skill_code = skill.skill_code
        WHERE skill.skill_code = code
          AND skill.state = 'ACTIVE'
          AND relation.profession_code = primary_profession
      )
    ) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF candidate_section_key = 'request.location' THEN
    IF NOT job_request_json_has_only_keys(candidate_payload, ARRAY[
      'municipalityCode', 'exactAddress', 'mapPin', 'textClarification'
    ])
      OR NOT job_request_optional_trimmed_text_valid(candidate_payload, 'exactAddress', 500)
      OR NOT job_request_optional_safe_text_valid(candidate_payload, 'textClarification', 1000) THEN
      RETURN false;
    END IF;
    IF candidate_payload ? 'municipalityCode'
       AND candidate_payload -> 'municipalityCode' <> 'null'::jsonb THEN
      IF jsonb_typeof(candidate_payload -> 'municipalityCode') <> 'string' THEN
        RETURN false;
      END IF;
      municipality := candidate_payload ->> 'municipalityCode';
      IF NOT EXISTS (
        SELECT 1 FROM location_municipalities location
        WHERE location.code = municipality AND location.is_active
      ) THEN
        RETURN false;
      END IF;
    END IF;
    IF candidate_payload ? 'mapPin'
       AND candidate_payload -> 'mapPin' <> 'null'::jsonb THEN
      IF jsonb_typeof(candidate_payload -> 'mapPin') <> 'object'
         OR NOT job_request_json_has_only_keys(
           candidate_payload -> 'mapPin', ARRAY['latitude', 'longitude']
         )
         OR NOT (candidate_payload -> 'mapPin' ? 'latitude')
         OR NOT (candidate_payload -> 'mapPin' ? 'longitude')
         OR jsonb_typeof(candidate_payload #> '{mapPin,latitude}') <> 'number'
         OR jsonb_typeof(candidate_payload #> '{mapPin,longitude}') <> 'number' THEN
        RETURN false;
      END IF;
      latitude := (candidate_payload #>> '{mapPin,latitude}')::numeric;
      longitude := (candidate_payload #>> '{mapPin,longitude}')::numeric;
      IF latitude NOT BETWEEN -90 AND 90
         OR longitude NOT BETWEEN -180 AND 180 THEN
        RETURN false;
      END IF;
    END IF;
    RETURN true;
  END IF;

  IF candidate_section_key = 'request.timing' THEN
    IF NOT job_request_json_has_only_keys(candidate_payload, ARRAY[
      'mode', 'startsOn', 'endsOn', 'completionDeadline'
    ])
      OR NOT job_request_optional_trimmed_text_valid(candidate_payload, 'startsOn', 10)
      OR NOT job_request_optional_trimmed_text_valid(candidate_payload, 'endsOn', 10)
      OR NOT job_request_optional_trimmed_text_valid(candidate_payload, 'completionDeadline', 10) THEN
      RETURN false;
    END IF;
    timing_mode := candidate_payload ->> 'mode';
    IF timing_mode IS NOT NULL
       AND timing_mode NOT IN ('AS_SOON_AS_POSSIBLE', 'SPECIFIC_PERIOD', 'FLEXIBLE') THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_each(candidate_payload) field
      WHERE field.key IN ('startsOn', 'endsOn', 'completionDeadline')
        AND field.value <> 'null'::jsonb
        AND (field.value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$'
    ) THEN
      RETURN false;
    END IF;
    IF timing_mode = 'SPECIFIC_PERIOD'
       AND ((candidate_payload ->> 'startsOn') IS NULL
         OR (candidate_payload ->> 'endsOn') IS NULL) THEN
      RETURN false;
    END IF;
    IF timing_mode IS DISTINCT FROM 'SPECIFIC_PERIOD'
       AND ((candidate_payload ->> 'startsOn') IS NOT NULL
         OR (candidate_payload ->> 'endsOn') IS NOT NULL) THEN
      RETURN false;
    END IF;
    IF candidate_payload ->> 'startsOn' IS NOT NULL
       AND candidate_payload ->> 'endsOn' IS NOT NULL
       AND (candidate_payload ->> 'endsOn')::date
         < (candidate_payload ->> 'startsOn')::date THEN
      RETURN false;
    END IF;
    IF candidate_payload ->> 'startsOn' IS NOT NULL
       AND candidate_payload ->> 'completionDeadline' IS NOT NULL
       AND (candidate_payload ->> 'completionDeadline')::date
         < (candidate_payload ->> 'startsOn')::date THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF candidate_section_key = 'request.budget' THEN
    IF NOT job_request_json_has_only_keys(candidate_payload, ARRAY[
      'mode', 'minimumAmountCents', 'maximumAmountCents', 'currency'
    ]) THEN
      RETURN false;
    END IF;
    budget_mode := candidate_payload ->> 'mode';
    IF budget_mode IS NULL THEN
      RETURN candidate_payload ->> 'currency' = 'EUR'
        AND candidate_payload -> 'minimumAmountCents' = 'null'::jsonb
        AND candidate_payload -> 'maximumAmountCents' = 'null'::jsonb;
    ELSIF budget_mode = 'UNKNOWN' THEN
      RETURN candidate_payload ->> 'currency' = 'EUR'
        AND candidate_payload -> 'minimumAmountCents' = 'null'::jsonb
        AND candidate_payload -> 'maximumAmountCents' = 'null'::jsonb;
    ELSIF candidate_payload ->> 'currency' <> 'EUR' THEN
      RETURN false;
    ELSIF budget_mode = 'UP_TO' THEN
      RETURN candidate_payload -> 'minimumAmountCents' = 'null'::jsonb
        AND jsonb_typeof(candidate_payload -> 'maximumAmountCents') = 'number'
        AND (candidate_payload ->> 'maximumAmountCents')::numeric BETWEEN 1 AND 2147483647
        AND ((candidate_payload ->> 'maximumAmountCents')::numeric % 1) = 0;
    ELSIF budget_mode = 'RANGE' THEN
      RETURN jsonb_typeof(candidate_payload -> 'minimumAmountCents') = 'number'
        AND jsonb_typeof(candidate_payload -> 'maximumAmountCents') = 'number'
        AND (candidate_payload ->> 'minimumAmountCents')::numeric BETWEEN 1 AND 2147483647
        AND (candidate_payload ->> 'maximumAmountCents')::numeric BETWEEN 1 AND 2147483647
        AND ((candidate_payload ->> 'minimumAmountCents')::numeric % 1) = 0
        AND ((candidate_payload ->> 'maximumAmountCents')::numeric % 1) = 0
        AND (candidate_payload ->> 'maximumAmountCents')::numeric
          >= (candidate_payload ->> 'minimumAmountCents')::numeric;
    END IF;
    RETURN false;
  END IF;

  IF candidate_section_key = 'request.details' THEN
    RETURN job_request_json_has_only_keys(candidate_payload, ARRAY[
      'materialResponsibility', 'siteInspection', 'approximateQuantity',
      'customRequirements'
    ])
      AND job_request_optional_safe_text_valid(
        candidate_payload, 'approximateQuantity', 300
      )
      AND job_request_optional_safe_text_valid(
        candidate_payload, 'customRequirements', 2000
      )
      AND (
        NOT (candidate_payload ? 'materialResponsibility')
        OR candidate_payload -> 'materialResponsibility' = 'null'::jsonb
        OR candidate_payload ->> 'materialResponsibility' IN (
          'CUSTOMER_PROVIDES', 'CRAFTSMAN_PROVIDES',
          'ADVICE_NEEDED', 'COMBINATION'
        )
      )
      AND (
        NOT (candidate_payload ? 'siteInspection')
        OR candidate_payload -> 'siteInspection' = 'null'::jsonb
        OR candidate_payload ->> 'siteInspection' IN ('LIKELY', 'MAYBE', 'UNKNOWN')
      );
  END IF;

  IF candidate_section_key = 'request.media' THEN
    RETURN job_request_json_has_only_keys(candidate_payload, ARRAY[
      'photoMediaAssetIds', 'documentMediaAssetIds'
    ])
      AND job_request_code_array_valid(
        candidate_payload, 'photoMediaAssetIds', 10,
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      AND job_request_code_array_valid(
        candidate_payload, 'documentMediaAssetIds', 128,
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      );
  END IF;

  RETURN false;
END;
$$;

CREATE FUNCTION validate_job_request_content_section()
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

CREATE TRIGGER job_request_content_section_guard
BEFORE INSERT ON job_request_draft_section_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_request_content_section();

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

COMMENT ON FUNCTION job_request_content_section_valid(uuid, text, integer, jsonb) IS
  'Server-owned R3-004 section schema. Unknown fields and ungoverned references fail closed.';
COMMENT ON FUNCTION job_request_missing_submission_requirements(uuid, integer) IS
  'Authoritative revision-aware R3-004 submission minimum; no client readiness token.';
