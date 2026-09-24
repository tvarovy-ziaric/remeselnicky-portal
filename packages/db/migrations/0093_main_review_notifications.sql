-- R4-017: review notification intent is derived only from the authoritative
-- customer-accepted completion and immutable review history. Payloads carry
-- navigation/state hints only; scores, comments and Job private data stay out.
CREATE FUNCTION emit_job_main_review_notification(
  target_job_id uuid,
  target_direction job_main_review_direction,
  recipient_id uuid,
  notification_kind text,
  event_at timestamptz,
  deadline_at timestamptz,
  unlock_cause text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  event_name text;
  event_key text;
  event_payload jsonb;
  opportunity job_main_review_opportunities%ROWTYPE;
  first_submission_count integer;
  reciprocal_unlock_at timestamptz;
BEGIN
  SELECT * INTO opportunity FROM job_main_review_opportunities candidate
  WHERE candidate.job_id = target_job_id
    AND candidate.direction = target_direction
    AND candidate.author_user_id = recipient_id;
  IF NOT FOUND OR opportunity.completion_kind <> 'CUSTOMER_ACCEPTED'
      OR opportunity.submission_deadline IS DISTINCT FROM deadline_at THEN
    RAISE EXCEPTION 'authoritative main review notification opportunity required';
  END IF;

  SELECT count(*), max(recorded_at)
    INTO first_submission_count, reciprocal_unlock_at
  FROM job_main_review_events
  WHERE job_id = target_job_id AND version = 1;

  IF notification_kind = 'INVITED' THEN
    IF unlock_cause IS NOT NULL
        OR event_at IS DISTINCT FROM opportunity.completed_at THEN
      RAISE EXCEPTION 'review invitation cannot have an unlock cause';
    END IF;
    event_name := 'job.review.main.invited';
    event_key := 'job:' || target_job_id::text || ':main-review:invited:'
      || target_direction::text;
    event_payload := jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'job_id', target_job_id::text,
      'direction', target_direction::text,
      'submission_deadline_epoch', extract(epoch FROM deadline_at)::bigint
    );
  ELSIF notification_kind = 'UNLOCKED'
      AND unlock_cause IN ('RECIPROCAL', 'DEADLINE') THEN
    IF (unlock_cause = 'RECIPROCAL' AND (
          first_submission_count <> 2
          OR event_at IS DISTINCT FROM reciprocal_unlock_at
        )) OR (unlock_cause = 'DEADLINE' AND (
          first_submission_count <> 1
          OR event_at IS DISTINCT FROM opportunity.submission_deadline
          OR clock_timestamp() < opportunity.submission_deadline
        )) THEN
      RAISE EXCEPTION 'authoritative main review unlock provenance required';
    END IF;
    event_name := 'job.review.main.unlocked';
    event_key := 'job:' || target_job_id::text || ':main-review:unlocked:'
      || target_direction::text;
    event_payload := jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'job_id', target_job_id::text,
      'direction', target_direction::text,
      'unlock_cause', unlock_cause
    );
  ELSE
    RAISE EXCEPTION 'unsupported main review notification intent';
  END IF;

  IF recipient_id IS NULL OR event_at IS NULL OR deadline_at IS NULL THEN
    RAISE EXCEPTION 'complete main review notification provenance required';
  END IF;

  RETURN insert_exact_notification_outbox_event(
    event_key, event_name, event_at,
    'JOB', target_job_id::text, event_payload,
    event_name, target_job_id::text, event_at
  );
END;
$$;

CREATE FUNCTION capture_job_main_review_invitation_notifications()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opportunity job_main_review_opportunities%ROWTYPE;
BEGIN
  IF NEW.kind <> 'ACCEPT' THEN RETURN NULL; END IF;

  FOR opportunity IN
    SELECT review_opportunity.*
    FROM job_main_review_opportunities review_opportunity
    JOIN job_completion_attempts attempt
      ON attempt.job_id = review_opportunity.job_id
    WHERE attempt.id = NEW.attempt_id
      AND review_opportunity.completion_kind = 'CUSTOMER_ACCEPTED'
    ORDER BY review_opportunity.direction
  LOOP
    PERFORM emit_job_main_review_notification(
      opportunity.job_id, opportunity.direction,
      opportunity.author_user_id, 'INVITED',
      opportunity.completed_at, opportunity.submission_deadline
    );
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_main_review_invitation_notification_capture
AFTER INSERT ON job_completion_decisions
FOR EACH ROW EXECUTE FUNCTION capture_job_main_review_invitation_notifications();

CREATE FUNCTION capture_job_main_review_reciprocal_unlock_notifications()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opportunity job_main_review_opportunities%ROWTYPE;
BEGIN
  IF NEW.version <> 1 OR NOT EXISTS (
    SELECT 1 FROM job_main_review_events opposite
    WHERE opposite.job_id = NEW.job_id
      AND opposite.direction <> NEW.direction
      AND opposite.version = 1
  ) THEN RETURN NULL; END IF;

  FOR opportunity IN
    SELECT * FROM job_main_review_opportunities candidate
    WHERE candidate.job_id = NEW.job_id
    ORDER BY candidate.direction
  LOOP
    PERFORM emit_job_main_review_notification(
      opportunity.job_id, opportunity.direction,
      opportunity.author_user_id, 'UNLOCKED',
      NEW.recorded_at, opportunity.submission_deadline, 'RECIPROCAL'
    );
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_main_review_reciprocal_unlock_notification_capture
AFTER INSERT ON job_main_review_events
FOR EACH ROW EXECUTE FUNCTION
  capture_job_main_review_reciprocal_unlock_notifications();

-- A scheduler/worker calls this bounded function periodically. The immutable
-- outbox key is the durable completion ledger: a retry exact-compares the same
-- deadline-derived intent and cannot create a second user notification.
CREATE FUNCTION enqueue_due_job_main_review_deadline_unlock_notifications(
  candidate_now timestamptz DEFAULT clock_timestamp(),
  candidate_limit integer DEFAULT 100
)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE target record;
DECLARE opportunity job_main_review_opportunities%ROWTYPE;
DECLARE inserted_count integer := 0;
DECLARE scan_now timestamptz;
BEGIN
  IF candidate_now IS NULL OR candidate_limit < 1 OR candidate_limit > 500 THEN
    RAISE EXCEPTION 'invalid main review deadline notification scan';
  END IF;
  scan_now := LEAST(candidate_now, clock_timestamp());

  FOR target IN
    SELECT job.id AS job_id, candidate.submission_deadline AS deadline_at
    FROM jobs job
    JOIN job_main_review_opportunities candidate ON candidate.job_id = job.id
      AND candidate.direction = 'CUSTOMER_TO_PROVIDER'
    WHERE candidate.submission_deadline <= scan_now
      AND 1 = (
        SELECT count(*) FROM job_main_review_events submitted
        WHERE submitted.job_id = job.id AND submitted.version = 1
      )
      -- Fully emitted historical Jobs must not occupy every bounded batch and
      -- starve later deadlines. A partial retry remains eligible until both
      -- exact recipient-direction intents exist.
      AND (NOT EXISTS (
        SELECT 1 FROM domain_outbox_events emitted
        WHERE emitted.idempotency_key = 'job:' || job.id::text
          || ':main-review:unlocked:CUSTOMER_TO_PROVIDER'
      ) OR NOT EXISTS (
        SELECT 1 FROM domain_outbox_events emitted
        WHERE emitted.idempotency_key = 'job:' || job.id::text
          || ':main-review:unlocked:PROVIDER_TO_CUSTOMER'
      ))
    ORDER BY candidate.submission_deadline, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT candidate_limit
  LOOP
    FOR opportunity IN
      SELECT * FROM job_main_review_opportunities candidate
      WHERE candidate.job_id = target.job_id
      ORDER BY candidate.direction
    LOOP
      IF emit_job_main_review_notification(
        opportunity.job_id, opportunity.direction,
        opportunity.author_user_id, 'UNLOCKED',
        target.deadline_at, opportunity.submission_deadline, 'DEADLINE'
      ) THEN
        inserted_count := inserted_count + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN inserted_count;
END;
$$;

-- Upgrades may already contain accepted completions or sealed submissions from
-- 0092. Backfill the same exact intents rather than making notification
-- correctness depend on whether the source INSERT happened before deployment.
DO $$
DECLARE opportunity job_main_review_opportunities%ROWTYPE;
DECLARE reciprocal record;
DECLARE inserted_in_batch integer;
BEGIN
  FOR opportunity IN
    SELECT * FROM job_main_review_opportunities candidate
    ORDER BY candidate.job_id, candidate.direction
  LOOP
    PERFORM emit_job_main_review_notification(
      opportunity.job_id, opportunity.direction,
      opportunity.author_user_id, 'INVITED',
      opportunity.completed_at, opportunity.submission_deadline
    );
  END LOOP;

  FOR reciprocal IN
    SELECT submitted.job_id, max(submitted.recorded_at) AS unlocked_at
    FROM job_main_review_events submitted
    WHERE submitted.version = 1
    GROUP BY submitted.job_id
    HAVING count(*) = 2
    ORDER BY submitted.job_id
  LOOP
    FOR opportunity IN
      SELECT * FROM job_main_review_opportunities candidate
      WHERE candidate.job_id = reciprocal.job_id
      ORDER BY candidate.direction
    LOOP
      PERFORM emit_job_main_review_notification(
        opportunity.job_id, opportunity.direction,
        opportunity.author_user_id, 'UNLOCKED',
        reciprocal.unlocked_at, opportunity.submission_deadline, 'RECIPROCAL'
      );
    END LOOP;
  END LOOP;

  LOOP
    inserted_in_batch :=
      enqueue_due_job_main_review_deadline_unlock_notifications(
        clock_timestamp(), 500
      );
    EXIT WHEN inserted_in_batch = 0;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION emit_job_main_review_notification(uuid,
  job_main_review_direction, uuid, text, timestamptz, timestamptz, text) IS
  'Privacy-minimal exact-once main-review outbox intent; never carries ratings, comments, address or contact data.';
COMMENT ON FUNCTION enqueue_due_job_main_review_deadline_unlock_notifications(
  timestamptz, integer) IS
  'Bounded idempotent worker entrypoint for one-sided sealed-review deadline unlock notifications; returns newly inserted outbox events.';
