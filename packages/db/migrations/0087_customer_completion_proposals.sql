-- D20: a customer suggestion is not a Job completion or provider handover.
CREATE TYPE job_completion_proposal_decision_kind AS ENUM ('AGREE', 'DISAGREE');

CREATE TABLE job_completion_proposals (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  proposal_number integer NOT NULL CHECK (proposal_number > 0),
  customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note text CHECK (note IS NULL OR (note = btrim(note)
    AND length(note) BETWEEN 1 AND 1000 AND note !~ '[[:cntrl:]]')),
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, proposal_number)
);
CREATE INDEX job_completion_proposals_job_idx ON job_completion_proposals
  (job_id, proposal_number DESC);

CREATE TABLE job_completion_proposal_decisions (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL UNIQUE REFERENCES job_completion_proposals(id) ON DELETE RESTRICT,
  kind job_completion_proposal_decision_kind NOT NULL,
  provider_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text,
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT proposal_decision_reason_shape CHECK (
    (kind = 'AGREE' AND reason IS NULL)
    OR (kind = 'DISAGREE' AND reason IS NOT NULL
      AND reason = btrim(reason) AND length(reason) BETWEEN 8 AND 1000
      AND reason !~ '[[:cntrl:]]')
  )
);

CREATE FUNCTION validate_job_completion_proposal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_state job_state; expected_actor_id uuid; next_number integer;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  PERFORM 1 FROM users WHERE id = NEW.customer_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.customer_user_id FOR SHARE;
  SELECT customer.owner_user_id, state.state
    INTO expected_actor_id, actual_state
  FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN users actor ON actor.id = NEW.customer_user_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials auth ON auth.user_id = actor.id
    AND auth.email_verified_at IS NOT NULL AND auth.phone_verified_at IS NOT NULL
  WHERE job.id = NEW.job_id;
  IF expected_actor_id IS DISTINCT FROM NEW.customer_user_id
    OR actual_state IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'active Job customer and IN_PROGRESS Job required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM job_completion_proposals proposal
    LEFT JOIN job_completion_proposal_decisions decision
      ON decision.proposal_id = proposal.id
    WHERE proposal.job_id = NEW.job_id AND decision.id IS NULL
  ) THEN RAISE EXCEPTION 'pending customer completion proposal exists'; END IF;
  SELECT coalesce(max(proposal_number), 0) + 1 INTO next_number
    FROM job_completion_proposals WHERE job_id = NEW.job_id;
  IF NEW.proposal_number <> next_number THEN
    RAISE EXCEPTION 'next completion proposal number required';
  END IF;
  NEW.proposed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_completion_proposal_validate BEFORE INSERT ON job_completion_proposals
  FOR EACH ROW EXECUTE FUNCTION validate_job_completion_proposal();

CREATE FUNCTION validate_job_completion_proposal_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; expected_actor_id uuid; actual_state job_state;
BEGIN
  SELECT job_id INTO target_job_id FROM job_completion_proposals WHERE id = NEW.proposal_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'completion proposal required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM users WHERE id = NEW.provider_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.provider_user_id FOR SHARE;
  SELECT provider.owner_user_id, state.state
    INTO expected_actor_id, actual_state
  FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN users actor ON actor.id = NEW.provider_user_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials auth ON auth.user_id = actor.id
    AND auth.email_verified_at IS NOT NULL AND auth.phone_verified_at IS NOT NULL
  WHERE job.id = target_job_id;
  IF expected_actor_id IS DISTINCT FROM NEW.provider_user_id
    OR actual_state IS DISTINCT FROM 'IN_PROGRESS'
    OR NEW.proposal_id IS DISTINCT FROM (
      SELECT id FROM job_completion_proposals WHERE job_id = target_job_id
      ORDER BY proposal_number DESC LIMIT 1
    ) THEN RAISE EXCEPTION 'exact pending customer proposal and provider required'; END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_completion_proposal_decision_validate
  BEFORE INSERT ON job_completion_proposal_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_job_completion_proposal_decision();

CREATE TRIGGER job_completion_proposal_immutable
  BEFORE UPDATE OR DELETE ON job_completion_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_job_completion_mutation();
CREATE TRIGGER job_completion_proposal_decision_immutable
  BEFORE UPDATE OR DELETE ON job_completion_proposal_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_job_completion_mutation();

-- The provider must explicitly answer an outstanding customer proposal before
-- sending the ordinary D20 request; no proposal silently becomes consent.
CREATE FUNCTION require_resolved_customer_completion_proposal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM job_completion_proposals proposal
    LEFT JOIN job_completion_proposal_decisions decision
      ON decision.proposal_id = proposal.id
    WHERE proposal.job_id = NEW.job_id AND decision.id IS NULL
  ) THEN RAISE EXCEPTION 'resolve customer completion proposal first'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_completion_attempt_customer_proposal_guard
  BEFORE INSERT ON job_completion_attempts
  FOR EACH ROW EXECUTE FUNCTION require_resolved_customer_completion_proposal();

CREATE FUNCTION notify_customer_completion_proposal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; recipient_id uuid; event_name text;
  occurred_at timestamptz; source_id uuid; target_proposal_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'job_completion_proposals' THEN
    target_job_id := NEW.job_id; target_proposal_id := NEW.id;
    occurred_at := NEW.proposed_at; source_id := NEW.id;
    event_name := 'job.completion.proposed';
    SELECT provider.owner_user_id INTO recipient_id FROM jobs job
      JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
      WHERE job.id = target_job_id;
  ELSE
    SELECT proposal.job_id INTO target_job_id FROM job_completion_proposals proposal
      WHERE proposal.id = NEW.proposal_id;
    target_proposal_id := NEW.proposal_id;
    occurred_at := NEW.decided_at; source_id := NEW.id;
    event_name := CASE NEW.kind WHEN 'AGREE' THEN 'job.completion.proposal_agreed'
      ELSE 'job.completion.proposal_disagreed' END;
    SELECT customer.owner_user_id INTO recipient_id FROM jobs job
      JOIN customer_profiles customer ON customer.id = job.customer_profile_id
      WHERE job.id = target_job_id;
  END IF;
  IF recipient_id IS NULL THEN RAISE EXCEPTION 'proposal recipient missing'; END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job.completion.proposal.' || source_id::text, event_name, occurred_at,
    'JOB', target_job_id::text,
    jsonb_build_object('recipient_user_id', recipient_id::text,
      'job_id', target_job_id::text, 'proposal_id', target_proposal_id::text),
    event_name, source_id::text, occurred_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_completion_proposal_notify AFTER INSERT ON job_completion_proposals
  FOR EACH ROW EXECUTE FUNCTION notify_customer_completion_proposal();
CREATE TRIGGER job_completion_proposal_decision_notify
  AFTER INSERT ON job_completion_proposal_decisions
  FOR EACH ROW EXECUTE FUNCTION notify_customer_completion_proposal();

COMMENT ON TABLE job_completion_proposals IS
  'Immutable customer suggestions; never Job completion or provider confirmation.';
COMMENT ON TABLE job_completion_proposal_decisions IS
  'Explicit provider agreement or reasoned disagreement, separate from ordinary completion request.';
