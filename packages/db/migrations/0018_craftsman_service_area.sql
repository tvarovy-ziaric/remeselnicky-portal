CREATE TABLE location_regions (
  code text PRIMARY KEY,
  name_sk text NOT NULL,
  source_reference text NOT NULL,
  source_revision text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT location_regions_code_safe CHECK (
    code = btrim(code)
    AND length(code) BETWEEN 1 AND 64
    AND code ~ '^[A-Z0-9][A-Z0-9._:-]*$'
  ),
  CONSTRAINT location_regions_name_safe CHECK (
    name_sk = btrim(name_sk) AND length(name_sk) BETWEEN 1 AND 160
  ),
  CONSTRAINT location_regions_source_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
    AND source_revision = btrim(source_revision)
    AND length(source_revision) BETWEEN 1 AND 120
  ),
  CONSTRAINT location_regions_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE TABLE location_districts (
  code text PRIMARY KEY,
  region_code text NOT NULL REFERENCES location_regions(code) ON DELETE RESTRICT,
  name_sk text NOT NULL,
  source_reference text NOT NULL,
  source_revision text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT location_districts_code_safe CHECK (
    code = btrim(code)
    AND length(code) BETWEEN 1 AND 64
    AND code ~ '^[A-Z0-9][A-Z0-9._:-]*$'
  ),
  CONSTRAINT location_districts_name_safe CHECK (
    name_sk = btrim(name_sk) AND length(name_sk) BETWEEN 1 AND 160
  ),
  CONSTRAINT location_districts_source_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
    AND source_revision = btrim(source_revision)
    AND length(source_revision) BETWEEN 1 AND 120
  ),
  CONSTRAINT location_districts_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE INDEX location_districts_region_code_idx
  ON location_districts (region_code, code);

CREATE TABLE location_municipalities (
  code text PRIMARY KEY,
  district_code text NOT NULL REFERENCES location_districts(code) ON DELETE RESTRICT,
  name_sk text NOT NULL,
  centroid geography(Point, 4326) NOT NULL,
  source_reference text NOT NULL,
  source_revision text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT location_municipalities_code_safe CHECK (
    code = btrim(code)
    AND length(code) BETWEEN 1 AND 64
    AND code ~ '^[A-Z0-9][A-Z0-9._:-]*$'
  ),
  CONSTRAINT location_municipalities_name_safe CHECK (
    name_sk = btrim(name_sk) AND length(name_sk) BETWEEN 1 AND 160
  ),
  CONSTRAINT location_municipalities_source_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
    AND source_revision = btrim(source_revision)
    AND length(source_revision) BETWEEN 1 AND 120
  ),
  CONSTRAINT location_municipalities_centroid_shape CHECK (
    ST_SRID(centroid::geometry) = 4326
    AND GeometryType(centroid::geometry) = 'POINT'
    AND ST_X(centroid::geometry) BETWEEN 16 AND 23
    AND ST_Y(centroid::geometry) BETWEEN 47 AND 50
  ),
  CONSTRAINT location_municipalities_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE INDEX location_municipalities_district_code_idx
  ON location_municipalities (district_code, code);
CREATE INDEX location_municipalities_centroid_gix
  ON location_municipalities USING gist (centroid);

CREATE FUNCTION guard_location_catalog_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governed location catalog rows are append-only';
END;
$$;

CREATE TRIGGER location_regions_history_guard
BEFORE UPDATE OR DELETE ON location_regions
FOR EACH ROW EXECUTE FUNCTION guard_location_catalog_mutation();
CREATE TRIGGER location_districts_history_guard
BEFORE UPDATE OR DELETE ON location_districts
FOR EACH ROW EXECUTE FUNCTION guard_location_catalog_mutation();
CREATE TRIGGER location_municipalities_history_guard
BEFORE UPDATE OR DELETE ON location_municipalities
FOR EACH ROW EXECUTE FUNCTION guard_location_catalog_mutation();

CREATE TYPE craftsman_service_area_command_result AS ENUM ('APPLIED', 'UNCHANGED');

CREATE TABLE craftsman_service_area_commands (
  command_id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL,
  result_kind craftsman_service_area_command_result NOT NULL,
  resulting_revision integer NOT NULL,
  base_municipality_code text REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  normal_radius_meters integer,
  maximum_radius_meters integer,
  extra_municipality_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  travel_fee_policy text,
  travel_fee_threshold_meters integer,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT craftsman_service_area_commands_expected_revision_nonnegative
    CHECK (expected_revision >= 0),
  CONSTRAINT craftsman_service_area_commands_resulting_revision_positive
    CHECK (resulting_revision > 0),
  CONSTRAINT craftsman_service_area_commands_radius_safe CHECK (
    (normal_radius_meters IS NULL OR normal_radius_meters > 0 AND normal_radius_meters <= 20040000)
    AND (maximum_radius_meters IS NULL OR maximum_radius_meters > 0 AND maximum_radius_meters <= 20040000)
    AND (travel_fee_threshold_meters IS NULL OR travel_fee_threshold_meters > 0 AND travel_fee_threshold_meters <= 20040000)
    AND (maximum_radius_meters IS NULL OR normal_radius_meters IS NOT NULL AND maximum_radius_meters >= normal_radius_meters)
  ),
  CONSTRAINT craftsman_service_area_commands_extra_codes_shape CHECK (
    jsonb_typeof(extra_municipality_codes) = 'array'
    AND jsonb_array_length(extra_municipality_codes) <= 256
  ),
  CONSTRAINT craftsman_service_area_commands_policy_safe CHECK (
    travel_fee_policy IS NULL OR (
      travel_fee_policy = btrim(travel_fee_policy)
      AND length(travel_fee_policy) BETWEEN 1 AND 1000
      AND travel_fee_policy !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
      AND travel_fee_policy !~* '(https?://|www\\.)'
      AND travel_fee_policy !~* '[^[:space:]@]+@[^[:space:]@]+\\.[[:alpha:]]{2,}'
      AND travel_fee_policy !~ E'\\+?[0-9]([[:space:]().-]*[0-9]){6,}'
    )
  ),
  CONSTRAINT craftsman_service_area_commands_fingerprint_sha256
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX craftsman_service_area_commands_profile_created_idx
  ON craftsman_service_area_commands (craftsman_profile_id, created_at DESC);

CREATE TABLE craftsman_service_area_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE
    REFERENCES craftsman_service_area_commands(command_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  base_municipality_code text REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  normal_radius_meters integer,
  maximum_radius_meters integer,
  travel_fee_policy text,
  travel_fee_threshold_meters integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT craftsman_service_area_revisions_profile_revision_key
    UNIQUE (craftsman_profile_id, revision),
  CONSTRAINT craftsman_service_area_revisions_revision_positive CHECK (revision > 0),
  CONSTRAINT craftsman_service_area_revisions_radius_safe CHECK (
    (normal_radius_meters IS NULL OR normal_radius_meters > 0 AND normal_radius_meters <= 20040000)
    AND (maximum_radius_meters IS NULL OR maximum_radius_meters > 0 AND maximum_radius_meters <= 20040000)
    AND (travel_fee_threshold_meters IS NULL OR travel_fee_threshold_meters > 0 AND travel_fee_threshold_meters <= 20040000)
    AND (maximum_radius_meters IS NULL OR normal_radius_meters IS NOT NULL AND maximum_radius_meters >= normal_radius_meters)
  ),
  CONSTRAINT craftsman_service_area_revisions_policy_safe CHECK (
    travel_fee_policy IS NULL OR (
      travel_fee_policy = btrim(travel_fee_policy)
      AND length(travel_fee_policy) BETWEEN 1 AND 1000
      AND travel_fee_policy !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
      AND travel_fee_policy !~* '(https?://|www\\.)'
      AND travel_fee_policy !~* '[^[:space:]@]+@[^[:space:]@]+\\.[[:alpha:]]{2,}'
      AND travel_fee_policy !~ E'\\+?[0-9]([[:space:]().-]*[0-9]){6,}'
    )
  )
);

CREATE TABLE craftsman_service_area_extra_municipalities (
  service_area_revision_id uuid NOT NULL
    REFERENCES craftsman_service_area_revisions(id) ON DELETE RESTRICT,
  municipality_code text NOT NULL
    REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  ordinal integer NOT NULL,
  PRIMARY KEY (service_area_revision_id, municipality_code),
  CONSTRAINT craftsman_service_area_extras_revision_ordinal_key
    UNIQUE (service_area_revision_id, ordinal),
  CONSTRAINT craftsman_service_area_extras_ordinal_positive CHECK (ordinal > 0)
);

CREATE FUNCTION validate_craftsman_service_area_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_id uuid;
  owner_state user_account_state;
  current_revision integer;
  current_base_municipality_code text;
  current_normal_radius_meters integer;
  current_maximum_radius_meters integer;
  current_travel_fee_policy text;
  current_travel_fee_threshold_meters integer;
  current_extras jsonb;
  item jsonb;
  item_code text;
  seen_codes text[] := ARRAY[]::text[];
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;

  IF NOT FOUND OR owner_id IS DISTINCT FROM NEW.actor_user_id OR owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active owned craftsman profile required for service-area command';
  END IF;

  SELECT COALESCE(max(revision), 0)
    INTO current_revision
  FROM craftsman_service_area_revisions
  WHERE craftsman_profile_id = NEW.craftsman_profile_id;

  IF NEW.expected_revision <> current_revision THEN
    RAISE EXCEPTION 'service-area command has stale revision';
  END IF;
  IF NEW.result_kind = 'APPLIED' THEN
    NEW.resulting_revision := current_revision + 1;
  ELSE
    IF current_revision = 0 THEN
      RAISE EXCEPTION 'unchanged service-area command requires existing revision';
    END IF;
    NEW.resulting_revision := current_revision;
    SELECT revision.base_municipality_code,
           revision.normal_radius_meters,
           revision.maximum_radius_meters,
           revision.travel_fee_policy,
           revision.travel_fee_threshold_meters,
           COALESCE(jsonb_agg(extra.municipality_code ORDER BY extra.ordinal)
             FILTER (WHERE extra.municipality_code IS NOT NULL), '[]'::jsonb)
      INTO current_base_municipality_code,
           current_normal_radius_meters,
           current_maximum_radius_meters,
           current_travel_fee_policy,
           current_travel_fee_threshold_meters,
           current_extras
    FROM craftsman_service_area_revisions revision
    LEFT JOIN craftsman_service_area_extra_municipalities extra
      ON extra.service_area_revision_id = revision.id
    WHERE revision.craftsman_profile_id = NEW.craftsman_profile_id
      AND revision.revision = current_revision
    GROUP BY revision.id;
    IF NOT FOUND
       OR current_base_municipality_code IS DISTINCT FROM NEW.base_municipality_code
       OR current_normal_radius_meters IS DISTINCT FROM NEW.normal_radius_meters
       OR current_maximum_radius_meters IS DISTINCT FROM NEW.maximum_radius_meters
       OR current_travel_fee_policy IS DISTINCT FROM NEW.travel_fee_policy
       OR current_travel_fee_threshold_meters IS DISTINCT FROM NEW.travel_fee_threshold_meters
       OR current_extras IS DISTINCT FROM NEW.extra_municipality_codes THEN
      RAISE EXCEPTION 'unchanged service-area command must match current state exactly';
    END IF;
  END IF;

  IF NEW.base_municipality_code IS NOT NULL THEN
    PERFORM 1 FROM location_municipalities municipality
    WHERE municipality.code = NEW.base_municipality_code AND municipality.is_active
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active governed municipality required';
    END IF;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(NEW.extra_municipality_codes)
  LOOP
    IF jsonb_typeof(item) <> 'string' THEN
      RAISE EXCEPTION 'extra service areas must contain municipality codes';
    END IF;
    item_code := item #>> '{}';
    IF item_code = NEW.base_municipality_code OR item_code = ANY(seen_codes) THEN
      RAISE EXCEPTION 'extra service-area municipality codes must be distinct';
    END IF;
    PERFORM 1 FROM location_municipalities municipality
    WHERE municipality.code = item_code AND municipality.is_active
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active governed municipality required';
    END IF;
    seen_codes := array_append(seen_codes, item_code);
  END LOOP;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_service_area_commands_insert_guard
BEFORE INSERT ON craftsman_service_area_commands
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_service_area_command();

CREATE FUNCTION validate_craftsman_service_area_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source craftsman_service_area_commands%ROWTYPE;
BEGIN
  SELECT * INTO source
  FROM craftsman_service_area_commands
  WHERE command_id = NEW.command_id
  FOR UPDATE;

  IF NOT FOUND OR source.result_kind <> 'APPLIED'
     OR source.craftsman_profile_id <> NEW.craftsman_profile_id
     OR source.base_municipality_code IS DISTINCT FROM NEW.base_municipality_code
     OR source.normal_radius_meters IS DISTINCT FROM NEW.normal_radius_meters
     OR source.maximum_radius_meters IS DISTINCT FROM NEW.maximum_radius_meters
     OR source.travel_fee_policy IS DISTINCT FROM NEW.travel_fee_policy
     OR source.travel_fee_threshold_meters IS DISTINCT FROM NEW.travel_fee_threshold_meters THEN
    RAISE EXCEPTION 'service-area revision must exactly match applied command provenance';
  END IF;

  NEW.revision := source.resulting_revision;
  NEW.created_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_service_area_revisions_insert_guard
BEFORE INSERT ON craftsman_service_area_revisions
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_service_area_revision();

CREATE FUNCTION validate_craftsman_service_area_extra()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  base_code text;
  expected_code text;
BEGIN
  SELECT revision.base_municipality_code,
         command.extra_municipality_codes ->> (NEW.ordinal - 1)
    INTO base_code, expected_code
  FROM craftsman_service_area_revisions revision
  JOIN craftsman_service_area_commands command ON command.command_id = revision.command_id
  WHERE revision.id = NEW.service_area_revision_id
  FOR UPDATE OF revision, command;

  IF NOT FOUND OR expected_code IS DISTINCT FROM NEW.municipality_code THEN
    RAISE EXCEPTION 'extra service area must exactly match command provenance and order';
  END IF;
  IF NEW.municipality_code = base_code OR NOT EXISTS (
    SELECT 1 FROM location_municipalities municipality
    WHERE municipality.code = NEW.municipality_code AND municipality.is_active
  ) THEN
    RAISE EXCEPTION 'active distinct governed municipality required for extra service area';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_service_area_extras_insert_guard
BEFORE INSERT ON craftsman_service_area_extra_municipalities
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_service_area_extra();

CREATE FUNCTION ensure_craftsman_service_area_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source craftsman_service_area_commands%ROWTYPE;
  revision_id uuid;
  actual_extras jsonb;
BEGIN
  SELECT * INTO source
  FROM craftsman_service_area_commands
  WHERE command_id = COALESCE(NEW.command_id, OLD.command_id);

  SELECT revision.id,
         COALESCE(jsonb_agg(extra.municipality_code ORDER BY extra.ordinal)
           FILTER (WHERE extra.municipality_code IS NOT NULL), '[]'::jsonb)
    INTO revision_id, actual_extras
  FROM craftsman_service_area_revisions revision
  LEFT JOIN craftsman_service_area_extra_municipalities extra
    ON extra.service_area_revision_id = revision.id
  WHERE revision.command_id = source.command_id
  GROUP BY revision.id;

  IF source.result_kind = 'APPLIED'
     AND (revision_id IS NULL OR actual_extras IS DISTINCT FROM source.extra_municipality_codes) THEN
    RAISE EXCEPTION 'applied service-area command requires exact revision effect';
  END IF;
  IF source.result_kind = 'UNCHANGED' AND revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'unchanged service-area command cannot create a revision effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER craftsman_service_area_command_effect_required
AFTER INSERT ON craftsman_service_area_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_service_area_command_effect();

CREATE FUNCTION reject_service_area_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'craftsman service-area history is append-only';
END;
$$;

CREATE TRIGGER craftsman_service_area_commands_append_only
BEFORE UPDATE OR DELETE ON craftsman_service_area_commands
FOR EACH ROW EXECUTE FUNCTION reject_service_area_history_mutation();
CREATE TRIGGER craftsman_service_area_revisions_append_only
BEFORE UPDATE OR DELETE ON craftsman_service_area_revisions
FOR EACH ROW EXECUTE FUNCTION reject_service_area_history_mutation();
CREATE TRIGGER craftsman_service_area_extras_append_only
BEFORE UPDATE OR DELETE ON craftsman_service_area_extra_municipalities
FOR EACH ROW EXECUTE FUNCTION reject_service_area_history_mutation();

CREATE VIEW current_craftsman_service_areas AS
SELECT DISTINCT ON (revision.craftsman_profile_id)
  revision.id,
  revision.craftsman_profile_id,
  revision.revision,
  revision.base_municipality_code,
  revision.normal_radius_meters,
  revision.maximum_radius_meters,
  revision.travel_fee_policy,
  revision.travel_fee_threshold_meters,
  revision.created_at
FROM craftsman_service_area_revisions revision
ORDER BY revision.craftsman_profile_id, revision.revision DESC;

COMMENT ON TABLE location_municipalities IS
  'Governed normalized municipality catalog; centroid is approximate matching data, never an owner home/address coordinate.';
COMMENT ON TABLE craftsman_service_area_revisions IS
  'Immutable private profile-wide service preference revisions; radius is a matching preference, not a contractual rejection or automatic travel price.';
