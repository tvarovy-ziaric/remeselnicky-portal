CREATE TYPE job_request_material_change_category AS ENUM (
  'ATTACHMENTS',
  'BUDGET',
  'LOCATION',
  'MATERIAL_RESPONSIBILITY',
  'OTHER_REQUIREMENTS',
  'PROFESSION',
  'SCHEDULE',
  'SCOPE'
);

CREATE TYPE job_request_active_edit_result AS ENUM ('APPLIED', 'UNCHANGED');

CREATE TABLE job_request_active_edit_commands (
  command_id uuid PRIMARY KEY,
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_content_revision integer NOT NULL,
  resulting_content_revision integer NOT NULL,
  resulting_visible_version integer NOT NULL,
  section_key varchar(64) NOT NULL,
  section_schema_version integer NOT NULL,
  section_payload jsonb NOT NULL,
  section_payload_fingerprint char(64) NOT NULL,
  intent_fingerprint char(64) NOT NULL,
  result_kind job_request_active_edit_result NOT NULL,
  material_change boolean NOT NULL,
  change_categories job_request_material_change_category[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_request_active_edit_revision_shape CHECK (
    expected_content_revision > 0
    AND resulting_visible_version > 0
    AND (
      (result_kind = 'APPLIED'
        AND resulting_content_revision = expected_content_revision + 1)
      OR (result_kind = 'UNCHANGED'
        AND resulting_content_revision = expected_content_revision)
    )
  ),
  CONSTRAINT job_request_active_edit_section_shape CHECK (
    section_key IN (
      'request.core', 'request.location', 'request.timing',
      'request.budget', 'request.details', 'request.media'
    )
    AND section_schema_version = 1
    AND jsonb_typeof(section_payload) = 'object'
    AND octet_length(section_payload::text) <= 34816
    AND section_payload_fingerprint ~ '^[0-9a-f]{64}$'
    AND intent_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT job_request_active_edit_classification_shape CHECK (
    (material_change AND cardinality(change_categories) > 0)
    OR (NOT material_change AND cardinality(change_categories) = 0)
  )
);

CREATE INDEX job_request_active_edit_history_idx
  ON job_request_active_edit_commands (
    job_request_id, resulting_content_revision, command_id
  );

CREATE TABLE job_request_active_content_revisions (
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  content_revision integer NOT NULL,
  visible_version integer NOT NULL,
  source_request_revision integer NOT NULL,
  command_id uuid UNIQUE REFERENCES job_request_active_edit_commands(command_id)
    ON DELETE RESTRICT,
  material_change boolean NOT NULL,
  change_categories job_request_material_change_category[] NOT NULL,
  changed_at timestamptz NOT NULL,
  created_txid bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (job_request_id, content_revision),
  FOREIGN KEY (job_request_id, source_request_revision)
    REFERENCES job_request_revisions(job_request_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT job_request_active_content_revision_shape CHECK (
    content_revision > 0 AND visible_version > 0
    AND (
      (content_revision = 1 AND visible_version = 1 AND command_id IS NULL
        AND NOT material_change AND cardinality(change_categories) = 0)
      OR (content_revision > 1 AND command_id IS NOT NULL
        AND ((material_change AND cardinality(change_categories) > 0)
          OR (NOT material_change AND cardinality(change_categories) = 0)))
    )
  )
);

CREATE TABLE job_request_active_section_revisions (
  job_request_id uuid NOT NULL,
  content_revision integer NOT NULL,
  command_id uuid REFERENCES job_request_active_edit_commands(command_id)
    ON DELETE RESTRICT,
  section_key varchar(64) NOT NULL,
  section_schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  saved_at timestamptz NOT NULL,
  created_txid bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (job_request_id, content_revision, section_key),
  FOREIGN KEY (job_request_id, content_revision)
    REFERENCES job_request_active_content_revisions(
      job_request_id, content_revision
    ) ON DELETE RESTRICT,
  CONSTRAINT job_request_active_section_command_once UNIQUE (command_id),
  CONSTRAINT job_request_active_section_shape CHECK (
    section_key IN (
      'request.core', 'request.location', 'request.timing',
      'request.budget', 'request.details', 'request.media'
    )
    AND section_schema_version = 1
    AND jsonb_typeof(payload) = 'object'
    AND octet_length(payload::text) <= 34816
    AND payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX job_request_active_section_history_idx
  ON job_request_active_section_revisions (
    job_request_id, section_key, content_revision DESC
  );

CREATE FUNCTION job_request_default_section_payload(candidate_key text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE candidate_key
    WHEN 'request.core' THEN jsonb_build_object(
      'description', NULL, 'primaryProfessionCode', NULL,
      'relatedProfessionCodes', '[]'::jsonb, 'skillCodes', '[]'::jsonb,
      'specializationCode', NULL, 'title', NULL
    )
    WHEN 'request.location' THEN jsonb_build_object(
      'exactAddress', NULL, 'mapPin', NULL, 'municipalityCode', NULL,
      'textClarification', NULL
    )
    WHEN 'request.timing' THEN jsonb_build_object(
      'completionDeadline', NULL, 'endsOn', NULL, 'mode', NULL,
      'startsOn', NULL
    )
    WHEN 'request.budget' THEN jsonb_build_object(
      'currency', 'EUR', 'maximumAmountCents', NULL,
      'minimumAmountCents', NULL, 'mode', NULL
    )
    WHEN 'request.details' THEN jsonb_build_object(
      'approximateQuantity', NULL, 'customRequirements', NULL,
      'materialResponsibility', NULL, 'siteInspection', NULL
    )
    WHEN 'request.media' THEN jsonb_build_object(
      'documentMediaAssetIds', '[]'::jsonb,
      'photoMediaAssetIds', '[]'::jsonb
    )
    ELSE NULL
  END;
$$;

CREATE FUNCTION job_request_classify_active_change(
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

CREATE FUNCTION job_request_active_media_available(
  candidate_request_id uuid,
  candidate_customer_id uuid,
  candidate_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE owner_id uuid; asset_id text;
BEGIN
  SELECT owner_user_id INTO owner_id FROM customer_profiles
  WHERE id = candidate_customer_id;
  IF owner_id IS NULL THEN RETURN false; END IF;
  FOR asset_id IN SELECT jsonb_array_elements_text(
    COALESCE(candidate_payload -> 'photoMediaAssetIds', '[]'::jsonb)
  ) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM media_assets asset
      WHERE asset.id = asset_id::uuid AND asset.owner_user_id = owner_id
        AND asset.status = 'READY' AND asset.kind = 'IMAGE'
        AND asset.purpose::text = 'JOB_REQUEST_IMAGE'
        AND asset.provenance_entity_type = 'JOB_REQUEST'
        AND asset.provenance_entity_id = candidate_request_id
    ) THEN RETURN false; END IF;
  END LOOP;
  FOR asset_id IN SELECT jsonb_array_elements_text(
    COALESCE(candidate_payload -> 'documentMediaAssetIds', '[]'::jsonb)
  ) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM media_assets asset
      WHERE asset.id = asset_id::uuid AND asset.owner_user_id = owner_id
        AND asset.status = 'READY' AND asset.kind = 'DOCUMENT'
        AND asset.purpose::text = 'JOB_REQUEST_DOCUMENT'
        AND asset.provenance_entity_type = 'JOB_REQUEST'
        AND asset.provenance_entity_id = candidate_request_id
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION create_job_request_active_content_baseline()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state <> 'ACTIVE' THEN RETURN NEW; END IF;
  INSERT INTO job_request_active_content_revisions (
    job_request_id, content_revision, visible_version,
    source_request_revision, command_id, material_change,
    change_categories, changed_at
  ) VALUES (
    NEW.job_request_id, 1, 1, NEW.revision, NULL, false,
    ARRAY[]::job_request_material_change_category[], NEW.changed_at
  );
  INSERT INTO job_request_active_section_revisions (
    job_request_id, content_revision, command_id, section_key,
    section_schema_version, payload, payload_fingerprint, saved_at
  )
  SELECT NEW.job_request_id, 1, NULL, source.section_key,
    source.section_schema_version, source.payload,
    source.payload_fingerprint, NEW.changed_at
  FROM (
    SELECT DISTINCT ON (section.section_key) section.*
    FROM job_request_draft_section_revisions section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.request_revision <= NEW.revision
    ORDER BY section.section_key, section.request_revision DESC
  ) source;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_request_active_content_baseline
AFTER INSERT ON job_request_revisions
FOR EACH ROW EXECUTE FUNCTION create_job_request_active_content_baseline();

INSERT INTO job_request_active_content_revisions (
  job_request_id, content_revision, visible_version,
  source_request_revision, command_id, material_change,
  change_categories, changed_at
)
SELECT current.id, 1, 1, current.revision, NULL, false,
  ARRAY[]::job_request_material_change_category[], current.changed_at
FROM current_job_requests current WHERE current.state = 'ACTIVE';

INSERT INTO job_request_active_section_revisions (
  job_request_id, content_revision, command_id, section_key,
  section_schema_version, payload, payload_fingerprint, saved_at
)
SELECT active.job_request_id, 1, NULL, source.section_key,
  source.section_schema_version, source.payload,
  source.payload_fingerprint, active.changed_at
FROM job_request_active_content_revisions active
JOIN LATERAL (
  SELECT DISTINCT ON (section.section_key) section.*
  FROM job_request_draft_section_revisions section
  WHERE section.job_request_id = active.job_request_id
    AND section.request_revision <= active.source_request_revision
  ORDER BY section.section_key, section.request_revision DESC
) source ON true
WHERE active.content_revision = 1;

CREATE VIEW current_job_request_active_content_versions AS
SELECT DISTINCT ON (revision.job_request_id)
  revision.job_request_id, revision.content_revision,
  revision.visible_version, revision.source_request_revision,
  revision.material_change, revision.change_categories, revision.changed_at
FROM job_request_active_content_revisions revision
ORDER BY revision.job_request_id, revision.content_revision DESC;

CREATE VIEW current_job_request_active_sections AS
SELECT DISTINCT ON (section.job_request_id, section.section_key)
  section.job_request_id, section.content_revision, section.section_key,
  section.section_schema_version, section.payload,
  section.payload_fingerprint, section.saved_at
FROM job_request_active_section_revisions section
JOIN current_job_request_active_content_versions current
  ON current.job_request_id = section.job_request_id
 AND section.content_revision <= current.content_revision
ORDER BY section.job_request_id, section.section_key,
  section.content_revision DESC;

CREATE FUNCTION validate_job_request_active_edit_command()
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

CREATE TRIGGER job_request_active_edit_commands_guard
BEFORE INSERT ON job_request_active_edit_commands
FOR EACH ROW EXECUTE FUNCTION validate_job_request_active_edit_command();

CREATE FUNCTION validate_job_request_active_content_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source job_request_active_edit_commands%ROWTYPE;
  prior job_request_active_content_revisions%ROWTYPE;
  lifecycle job_request_revisions%ROWTYPE;
BEGIN
  IF NEW.content_revision = 1 AND NEW.command_id IS NULL THEN
    SELECT * INTO lifecycle FROM job_request_revisions
    WHERE job_request_id = NEW.job_request_id
      AND revision = NEW.source_request_revision;
    IF NOT FOUND OR lifecycle.state <> 'ACTIVE'
       OR NEW.changed_at <> lifecycle.changed_at THEN
      RAISE EXCEPTION 'active content baseline must match activation';
    END IF;
    NEW.created_txid := txid_current();
    RETURN NEW;
  END IF;
  SELECT * INTO source FROM job_request_active_edit_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  SELECT * INTO prior FROM job_request_active_content_revisions
  WHERE job_request_id = NEW.job_request_id
  ORDER BY content_revision DESC LIMIT 1 FOR UPDATE;
  IF source.command_id IS NULL OR prior.job_request_id IS NULL
     OR source.result_kind <> 'APPLIED'
     OR source.job_request_id <> NEW.job_request_id
     OR source.resulting_content_revision <> NEW.content_revision
     OR source.resulting_visible_version <> NEW.visible_version
     OR source.material_change <> NEW.material_change
     OR source.change_categories <> NEW.change_categories
     OR prior.content_revision <> source.expected_content_revision
     OR NEW.source_request_revision <> prior.source_request_revision THEN
    RAISE EXCEPTION 'active content revision must exactly match its command';
  END IF;
  NEW.changed_at := source.created_at;
  NEW.created_txid := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_request_active_content_revisions_guard
BEFORE INSERT ON job_request_active_content_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_request_active_content_revision();

CREATE FUNCTION validate_job_request_active_section_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source job_request_active_edit_commands%ROWTYPE;
  parent job_request_active_content_revisions%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM job_request_active_content_revisions
  WHERE job_request_id = NEW.job_request_id
    AND content_revision = NEW.content_revision FOR UPDATE;
  IF NOT FOUND OR parent.created_txid <> txid_current() THEN
    RAISE EXCEPTION 'active section must be installed with its revision';
  END IF;
  IF NEW.content_revision = 1 AND NEW.command_id IS NULL THEN
    NEW.created_txid := txid_current();
    RETURN NEW;
  END IF;
  SELECT * INTO source FROM job_request_active_edit_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF source.command_id IS NULL OR source.result_kind <> 'APPLIED'
     OR source.job_request_id <> NEW.job_request_id
     OR source.resulting_content_revision <> NEW.content_revision
     OR source.section_key <> NEW.section_key
     OR source.section_schema_version <> NEW.section_schema_version
     OR source.section_payload <> NEW.payload
     OR source.section_payload_fingerprint <> NEW.payload_fingerprint THEN
    RAISE EXCEPTION 'active section revision must exactly match its command';
  END IF;
  NEW.saved_at := source.created_at;
  NEW.created_txid := txid_current();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_request_active_section_revisions_guard
BEFORE INSERT ON job_request_active_section_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_request_active_section_revision();

CREATE FUNCTION ensure_job_request_active_edit_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.result_kind = 'APPLIED' AND (
    NOT EXISTS (
      SELECT 1 FROM job_request_active_content_revisions revision
      WHERE revision.command_id = NEW.command_id
    ) OR NOT EXISTS (
      SELECT 1 FROM job_request_active_section_revisions section
      WHERE section.command_id = NEW.command_id
    )
  ) THEN RAISE EXCEPTION 'applied active edit requires exact effects'; END IF;
  IF NEW.result_kind = 'UNCHANGED' AND (
    EXISTS (SELECT 1 FROM job_request_active_content_revisions
      WHERE command_id = NEW.command_id)
    OR EXISTS (SELECT 1 FROM job_request_active_section_revisions
      WHERE command_id = NEW.command_id)
  ) THEN RAISE EXCEPTION 'unchanged active edit cannot create effects'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER job_request_active_edit_effect_required
AFTER INSERT ON job_request_active_edit_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_job_request_active_edit_effect();

CREATE TRIGGER job_request_active_edit_commands_append_only
BEFORE UPDATE OR DELETE ON job_request_active_edit_commands
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();
CREATE TRIGGER job_request_active_content_revisions_append_only
BEFORE UPDATE OR DELETE ON job_request_active_content_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();
CREATE TRIGGER job_request_active_section_revisions_append_only
BEFORE UPDATE OR DELETE ON job_request_active_section_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_request_history_mutation();

COMMENT ON TABLE job_request_active_content_revisions IS
  'Append-only active JobRequest content/version provenance; material edits increment visible_version.';
COMMENT ON TABLE job_request_active_section_revisions IS
  'PRIVATE active request content history; never log, analyze, or publicly serialize directly.';
