-- Accepted and losing Quote states are append-only effects of one Job.
ALTER TABLE quote_revision_state_events
  ADD COLUMN acceptance_job_id uuid REFERENCES jobs(id) ON DELETE RESTRICT,
  DROP CONSTRAINT quote_state_event_one_command_source,
  ADD CONSTRAINT quote_state_event_one_command_source CHECK (
    num_nonnulls(command_id, lifecycle_command_id, acceptance_job_id) = 1
  ),
  ADD CONSTRAINT quote_acceptance_state_event_unique UNIQUE (
    acceptance_job_id, quote_id, quote_revision, state_revision, state
  );

DROP TRIGGER quote_revision_state_events_guard
  ON quote_revision_state_events;
CREATE TRIGGER quote_revision_state_events_guard
BEFORE INSERT ON quote_revision_state_events
FOR EACH ROW WHEN (NEW.acceptance_job_id IS NULL)
EXECUTE FUNCTION validate_quote_revision_state_event();

CREATE FUNCTION validate_quote_acceptance_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source jobs%ROWTYPE;
  prior current_quote_revision_states%ROWTYPE;
  quote_request_id uuid;
BEGIN
  SELECT * INTO source FROM jobs WHERE id = NEW.acceptance_job_id FOR UPDATE;
  SELECT invitation.job_request_id INTO quote_request_id
  FROM quotes quote
  JOIN job_invitations invitation ON invitation.id = quote.invitation_id
  WHERE quote.id = NEW.quote_id;
  SELECT * INTO prior FROM current_quote_revision_states current
  WHERE current.quote_id = NEW.quote_id
    AND current.revision = NEW.quote_revision;
  IF source.id IS NULL OR quote_request_id IS DISTINCT FROM source.job_request_id
      OR prior.state IS DISTINCT FROM 'SUBMITTED' THEN
    RAISE EXCEPTION 'submitted Quote on accepted request required';
  END IF;
  IF NEW.state = 'ACCEPTED' THEN
    IF NEW.quote_id <> source.accepted_quote_id
        OR NEW.quote_revision <> source.accepted_quote_revision THEN
      RAISE EXCEPTION 'accepted Quote must match winning Job identity';
    END IF;
  ELSIF NEW.state = 'NOT_SELECTED' THEN
    IF NEW.quote_id = source.accepted_quote_id THEN
      RAISE EXCEPTION 'winning Quote cannot be not-selected';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported Job acceptance Quote state';
  END IF;
  NEW.command_id := NULL;
  NEW.lifecycle_command_id := NULL;
  NEW.state_revision := prior.state_revision + 1;
  NEW.submitted_at := prior.submitted_at;
  NEW.rejection_reason := NULL;
  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_acceptance_state_events_guard
BEFORE INSERT ON quote_revision_state_events
FOR EACH ROW WHEN (NEW.acceptance_job_id IS NOT NULL)
EXECUTE FUNCTION validate_quote_acceptance_state_event();

COMMENT ON COLUMN quote_revision_state_events.acceptance_job_id IS
  'Job provenance for immutable ACCEPTED or NOT_SELECTED Quote closeout. Acceptance HTTP remains unavailable until the full transactional command is implemented.';
