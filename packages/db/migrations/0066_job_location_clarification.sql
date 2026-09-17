-- R4-004: additive, customer-authorized execution-location clarification.
-- Existing address/coordinates and the accepted agreement are never rewritten.
CREATE TABLE job_location_clarification_commands (
  command_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  location_payload jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  payload_fingerprint text NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, expected_revision)
);

ALTER TABLE job_location_revisions
  ADD COLUMN source_clarification_command_id uuid UNIQUE
    REFERENCES job_location_clarification_commands(command_id)
    ON DELETE RESTRICT;
ALTER TABLE job_location_revisions
  DROP CONSTRAINT job_location_revisions_origin_check;
ALTER TABLE job_location_revisions
  ADD CONSTRAINT job_location_revision_origin_check CHECK (
    (origin = 'ACCEPTED_REQUEST'
      AND revision = 1
      AND source_clarification_command_id IS NULL)
    OR (origin = 'CUSTOMER_CLARIFICATION'
      AND revision > 1
      AND source_clarification_command_id IS NOT NULL)
  );

CREATE FUNCTION validate_job_location_clarification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_revision integer;
  current_payload jsonb;
  field_name text;
  old_value jsonb;
  new_value jsonb;
  changed boolean := false;
  pin jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM jobs job
    WHERE job.id = NEW.job_id AND job.initial_state = 'CONFIRMED'
  ) THEN
    RAISE EXCEPTION 'confirmed Job required for location clarification';
  END IF;
  PERFORM 1 FROM jobs job WHERE job.id = NEW.job_id FOR UPDATE;
  PERFORM 1 FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials
    WHERE user_id = NEW.actor_user_id FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM jobs job
    JOIN customer_profiles customer
      ON customer.id = job.customer_profile_id
    JOIN users actor ON actor.id = customer.owner_user_id
    JOIN auth_credentials credentials ON credentials.user_id = actor.id
    JOIN job_acceptance_events accepted ON accepted.job_id = job.id
    JOIN job_system_timeline_events unlocked ON unlocked.job_id = job.id
      AND unlocked.source_acceptance_event_id = accepted.event_id
      AND unlocked.event_type = 'CONTACT_ADDRESS_UNLOCKED'
    WHERE job.id = NEW.job_id AND actor.id = NEW.actor_user_id
      AND actor.account_state = 'ACTIVE'
      AND credentials.email_verified_at IS NOT NULL
      AND credentials.phone_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'customer not authorized for location clarification';
  END IF;
  SELECT location.revision, location.location_payload
    INTO current_revision, current_payload
  FROM current_job_locations location WHERE location.job_id = NEW.job_id;
  IF current_revision IS NULL OR current_revision <> NEW.expected_revision THEN
    RAISE EXCEPTION 'stale Job location revision';
  END IF;

  IF jsonb_typeof(NEW.location_payload) <> 'object'
      OR NOT NEW.location_payload ?& ARRAY[
        'municipalityCode', 'exactAddress', 'mapPin', 'textClarification'
      ]
      OR NEW.location_payload - 'municipalityCode' - 'exactAddress'
        - 'mapPin' - 'textClarification' <> '{}'::jsonb
      OR jsonb_typeof(NEW.location_payload -> 'municipalityCode') <> 'string'
      OR NEW.location_payload ->> 'municipalityCode' <>
        current_payload ->> 'municipalityCode'
      OR jsonb_typeof(NEW.location_payload -> 'exactAddress')
        NOT IN ('string', 'null')
      OR jsonb_typeof(NEW.location_payload -> 'textClarification')
        NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid Job location clarification';
  END IF;
  IF jsonb_typeof(NEW.location_payload -> 'exactAddress') = 'string'
      AND length(btrim(NEW.location_payload ->> 'exactAddress'))
        NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid exact address clarification';
  END IF;
  IF jsonb_typeof(NEW.location_payload -> 'textClarification') = 'string'
      AND length(btrim(NEW.location_payload ->> 'textClarification'))
        NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid text clarification';
  END IF;
  pin := NEW.location_payload -> 'mapPin';
  IF jsonb_typeof(pin) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid map pin clarification';
  END IF;
  IF jsonb_typeof(pin) = 'object' THEN
    IF NOT pin ?& ARRAY['latitude', 'longitude']
        OR pin - 'latitude' - 'longitude' <> '{}'::jsonb
        OR jsonb_typeof(pin -> 'latitude') <> 'number'
        OR jsonb_typeof(pin -> 'longitude') <> 'number' THEN
      RAISE EXCEPTION 'invalid map pin clarification';
    END IF;
    IF (pin ->> 'latitude')::numeric NOT BETWEEN -90 AND 90
        OR (pin ->> 'longitude')::numeric NOT BETWEEN -180 AND 180 THEN
      RAISE EXCEPTION 'map pin outside coordinate range';
    END IF;
  END IF;

  FOREACH field_name IN ARRAY ARRAY[
    'exactAddress', 'mapPin', 'textClarification'
  ] LOOP
    old_value := coalesce(current_payload -> field_name, 'null'::jsonb);
    new_value := NEW.location_payload -> field_name;
    IF old_value <> 'null'::jsonb AND new_value <> old_value THEN
      RAISE EXCEPTION 'existing Job location details cannot be overwritten';
    END IF;
    IF new_value <> old_value THEN changed := true; END IF;
  END LOOP;
  IF NOT changed THEN
    RAISE EXCEPTION 'Job location clarification must add a missing detail';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_location_clarification_validate
BEFORE INSERT ON job_location_clarification_commands
FOR EACH ROW EXECUTE FUNCTION validate_job_location_clarification();

CREATE FUNCTION capture_job_location_clarification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO job_location_revisions (
    job_id, revision, location_payload, origin,
    source_request_content_revision, recorded_at,
    source_clarification_command_id
  )
  SELECT NEW.job_id, NEW.expected_revision + 1, NEW.location_payload,
    'CUSTOMER_CLARIFICATION', initial.source_request_content_revision,
    NEW.recorded_at, NEW.command_id
  FROM job_location_revisions initial
  WHERE initial.job_id = NEW.job_id AND initial.revision = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted Job location required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_location_clarification_capture
AFTER INSERT ON job_location_clarification_commands
FOR EACH ROW EXECUTE FUNCTION capture_job_location_clarification();

CREATE FUNCTION guard_job_location_clarification_command()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job location clarification commands are immutable';
END;
$$;

CREATE TRIGGER job_location_clarification_immutable
BEFORE UPDATE OR DELETE ON job_location_clarification_commands
FOR EACH ROW EXECUTE FUNCTION guard_job_location_clarification_command();

CREATE OR REPLACE FUNCTION guard_job_location_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Job location history is immutable';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Job location must derive from an authorized source';
  END IF;
  IF NEW.origin = 'ACCEPTED_REQUEST' AND NEW.revision = 1
      AND NEW.source_clarification_command_id IS NULL
      AND EXISTS (
        SELECT 1 FROM job_agreement_snapshots snapshot
        JOIN jobs job ON job.id = snapshot.job_id
        WHERE snapshot.job_id = NEW.job_id
          AND snapshot.request_snapshot #>
            '{sections,request.location,payload}' = NEW.location_payload
          AND job.accepted_request_content_revision =
            NEW.source_request_content_revision
          AND snapshot.captured_at = NEW.recorded_at
      ) THEN
    RETURN NEW;
  END IF;
  IF NEW.origin = 'CUSTOMER_CLARIFICATION'
      AND NEW.source_clarification_command_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM job_location_clarification_commands command
        JOIN job_location_revisions initial
          ON initial.job_id = command.job_id AND initial.revision = 1
        WHERE command.command_id = NEW.source_clarification_command_id
          AND command.job_id = NEW.job_id
          AND command.expected_revision + 1 = NEW.revision
          AND command.location_payload = NEW.location_payload
          AND command.recorded_at = NEW.recorded_at
          AND initial.source_request_content_revision =
            NEW.source_request_content_revision
      ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Job location must derive from an authorized source';
END;
$$;

COMMENT ON TABLE job_location_clarification_commands IS
  'Immutable customer-authorized addition of missing private Job location details within the accepted municipality. Material corrections require a separate agreed workflow.';
