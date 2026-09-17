-- The Job is the immutable agreement identity; this event is its explicit,
-- privacy-minimal acceptance audit record and command correlation.
CREATE TABLE job_acceptance_events (
  event_id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  primary_craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  accepted_quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  accepted_quote_revision integer NOT NULL,
  accepted_request_content_revision integer NOT NULL,
  confirmation_contract text NOT NULL
    CHECK (confirmation_contract = 'SERVER_ACCEPT_QUOTE_V1'),
  occurred_at timestamptz NOT NULL
);

CREATE FUNCTION record_job_acceptance_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO job_acceptance_events (
    event_id, job_id, command_id, actor_user_id, customer_profile_id,
    primary_craftsman_profile_id, job_request_id, accepted_quote_id,
    accepted_quote_revision, accepted_request_content_revision,
    confirmation_contract, occurred_at
  ) VALUES (
    gen_random_uuid(), NEW.id, NEW.acceptance_command_id,
    NEW.accepted_by_user_id, NEW.customer_profile_id,
    NEW.primary_craftsman_profile_id, NEW.job_request_id,
    NEW.accepted_quote_id, NEW.accepted_quote_revision,
    NEW.accepted_request_content_revision, 'SERVER_ACCEPT_QUOTE_V1',
    NEW.accepted_at
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER jobs_record_acceptance_event
AFTER INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION record_job_acceptance_event();

CREATE FUNCTION reject_job_acceptance_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job acceptance event is immutable';
END;
$$;

CREATE TRIGGER job_acceptance_events_immutable
BEFORE UPDATE OR DELETE ON job_acceptance_events
FOR EACH ROW EXECUTE FUNCTION reject_job_acceptance_event_mutation();

COMMENT ON TABLE job_acceptance_events IS
  'Immutable accepted-Job action record: exact actor, parties, command, quote/request revisions and server time, without address, contact, chat, PDF or device data.';
