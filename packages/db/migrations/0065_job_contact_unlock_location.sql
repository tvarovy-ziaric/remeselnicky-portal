-- R4-004: the accepted agreement remains immutable. A separate Job location
-- history starts with the exact accepted request location, and a privacy-minimal
-- system timeline records confirmation and contact/address unlock atomically.
LOCK TABLE jobs, job_agreement_snapshots, job_acceptance_events
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE job_location_revisions (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  location_payload jsonb NOT NULL,
  origin text NOT NULL CHECK (origin = 'ACCEPTED_REQUEST'),
  source_request_content_revision integer NOT NULL CHECK (
    source_request_content_revision > 0
  ),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, revision),
  CONSTRAINT job_location_payload_is_valid CHECK (
    jsonb_typeof(location_payload) = 'object'
    AND jsonb_typeof(location_payload -> 'municipalityCode') = 'string'
    AND length(btrim(location_payload ->> 'municipalityCode')) > 0
  )
);

INSERT INTO job_location_revisions (
  job_id, revision, location_payload, origin,
  source_request_content_revision, recorded_at
)
SELECT job.id, 1,
  snapshot.request_snapshot #> '{sections,request.location,payload}',
  'ACCEPTED_REQUEST', job.accepted_request_content_revision,
  snapshot.captured_at
FROM jobs job
JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id;

CREATE VIEW current_job_locations AS
SELECT DISTINCT ON (location.job_id)
  location.job_id, location.revision, location.location_payload,
  location.origin, location.recorded_at
FROM job_location_revisions location
ORDER BY location.job_id, location.revision DESC;

CREATE FUNCTION capture_job_initial_location()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  accepted_request_revision integer;
BEGIN
  SELECT job.accepted_request_content_revision
    INTO accepted_request_revision
  FROM jobs job WHERE job.id = NEW.job_id;
  IF accepted_request_revision IS NULL THEN
    RAISE EXCEPTION 'accepted Job required for initial location';
  END IF;
  INSERT INTO job_location_revisions (
    job_id, revision, location_payload, origin,
    source_request_content_revision, recorded_at
  ) VALUES (
    NEW.job_id, 1,
    NEW.request_snapshot #> '{sections,request.location,payload}',
    'ACCEPTED_REQUEST', accepted_request_revision, NEW.captured_at
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_agreement_capture_initial_location
AFTER INSERT ON job_agreement_snapshots
FOR EACH ROW EXECUTE FUNCTION capture_job_initial_location();

CREATE FUNCTION guard_job_location_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Job location history is immutable';
  END IF;
  IF pg_trigger_depth() < 2
      OR NEW.revision <> 1
      OR NEW.origin <> 'ACCEPTED_REQUEST'
      OR NOT EXISTS (
        SELECT 1 FROM job_agreement_snapshots snapshot
        JOIN jobs job ON job.id = snapshot.job_id
        WHERE snapshot.job_id = NEW.job_id
          AND snapshot.request_snapshot #>
            '{sections,request.location,payload}' = NEW.location_payload
          AND job.accepted_request_content_revision =
            NEW.source_request_content_revision
          AND snapshot.captured_at = NEW.recorded_at
      ) THEN
    RAISE EXCEPTION 'Job location must derive from accepted snapshot';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_location_history_guard
BEFORE INSERT OR UPDATE OR DELETE ON job_location_revisions
FOR EACH ROW EXECUTE FUNCTION guard_job_location_history();

CREATE TABLE job_system_timeline_events (
  event_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  event_order smallint NOT NULL,
  event_type text NOT NULL,
  source_acceptance_event_id uuid NOT NULL
    REFERENCES job_acceptance_events(event_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  UNIQUE (job_id, event_order),
  UNIQUE (job_id, event_type, source_acceptance_event_id),
  CONSTRAINT job_initial_timeline_type_order CHECK (
    (event_type = 'JOB_CONFIRMED' AND event_order = 1)
    OR (event_type = 'CONTACT_ADDRESS_UNLOCKED' AND event_order = 2)
  )
);

INSERT INTO job_system_timeline_events (
  event_id, job_id, event_order, event_type,
  source_acceptance_event_id, occurred_at
)
SELECT gen_random_uuid(), accepted.job_id, event.event_order,
  event.event_type, accepted.event_id, accepted.occurred_at
FROM job_acceptance_events accepted
CROSS JOIN (VALUES
  (1::smallint, 'JOB_CONFIRMED'::text),
  (2::smallint, 'CONTACT_ADDRESS_UNLOCKED'::text)
) AS event(event_order, event_type);

CREATE FUNCTION record_job_initial_timeline()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO job_system_timeline_events (
    event_id, job_id, event_order, event_type,
    source_acceptance_event_id, occurred_at
  ) VALUES
    (gen_random_uuid(), NEW.job_id, 1, 'JOB_CONFIRMED',
      NEW.event_id, NEW.occurred_at),
    (gen_random_uuid(), NEW.job_id, 2, 'CONTACT_ADDRESS_UNLOCKED',
      NEW.event_id, NEW.occurred_at);
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_acceptance_record_initial_timeline
AFTER INSERT ON job_acceptance_events
FOR EACH ROW EXECUTE FUNCTION record_job_initial_timeline();

CREATE FUNCTION guard_job_initial_timeline()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Job system timeline is immutable';
  END IF;
  IF pg_trigger_depth() < 2 OR NOT EXISTS (
    SELECT 1 FROM job_acceptance_events accepted
    WHERE accepted.event_id = NEW.source_acceptance_event_id
      AND accepted.job_id = NEW.job_id
      AND accepted.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'Job system event must derive from acceptance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_system_timeline_guard
BEFORE INSERT OR UPDATE OR DELETE ON job_system_timeline_events
FOR EACH ROW EXECUTE FUNCTION guard_job_initial_timeline();

COMMENT ON TABLE job_location_revisions IS
  'Append-only Job work-location history. Revision one copies the accepted request location; later corrections need a dedicated authorized command.';
COMMENT ON TABLE job_system_timeline_events IS
  'Privacy-minimal immutable Job system events: confirmation and contact/address unlock contain no address, phone or email.';
