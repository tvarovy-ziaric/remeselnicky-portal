-- D20: immutable bilateral handover attempts, separate from payment/reviews.
CREATE TYPE job_completion_decision_kind AS ENUM ('ACCEPT', 'REJECT', 'WITHDRAW');
CREATE TYPE job_completion_rejection_category AS ENUM (
  'UNFINISHED_SCOPE', 'DEFECT', 'MISSING_OUTPUT', 'OTHER'
);

CREATE TABLE job_completion_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note text CHECK (note IS NULL OR (note = btrim(note)
    AND length(note) BETWEEN 1 AND 1000 AND note !~ '[[:cntrl:]]')),
  physical_work_finished_on date,
  final_media_asset_ids uuid[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(final_media_asset_ids) <= 10
  ),
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, attempt_number), UNIQUE (job_id, id)
);
CREATE INDEX job_completion_attempts_job_idx ON job_completion_attempts
  (job_id, attempt_number DESC);

CREATE TABLE job_completion_decisions (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES job_completion_attempts(id) ON DELETE RESTRICT,
  kind job_completion_decision_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rejection_category job_completion_rejection_category,
  reason text,
  evidence_media_asset_ids uuid[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(evidence_media_asset_ids) <= 10
  ),
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_completion_decision_shape CHECK (
    (kind = 'ACCEPT' AND rejection_category IS NULL AND reason IS NULL
      AND cardinality(evidence_media_asset_ids) = 0)
    OR (kind = 'REJECT' AND rejection_category IS NOT NULL
      AND reason IS NOT NULL AND reason = btrim(reason)
      AND length(reason) BETWEEN 8 AND 1000 AND reason !~ '[[:cntrl:]]')
    OR (kind = 'WITHDRAW' AND rejection_category IS NULL
      AND reason IS NOT NULL AND reason = btrim(reason)
      AND length(reason) BETWEEN 8 AND 1000 AND reason !~ '[[:cntrl:]]'
      AND cardinality(evidence_media_asset_ids) = 0)
  )
);

CREATE OR REPLACE VIEW current_job_states AS
SELECT job.id AS job_id,
  CASE
    WHEN cancelled.command_id IS NOT NULL THEN 'CANCELLED'::job_state
    WHEN latest.id IS NOT NULL AND decision.kind = 'ACCEPT'
      THEN 'COMPLETED'::job_state
    WHEN latest.id IS NOT NULL AND decision.id IS NULL
      THEN 'COMPLETION_REQUESTED'::job_state
    WHEN started.command_id IS NOT NULL THEN 'IN_PROGRESS'::job_state
    ELSE 'CONFIRMED'::job_state
  END AS state,
  started.recorded_at AS started_at,
  started.actor_user_id AS started_by_user_id,
  cancelled.recorded_at AS cancelled_at,
  cancelled.actor_user_id AS cancelled_by_user_id,
  cancelled.actor_role AS cancellation_initiator_role,
  cancelled.reason AS cancellation_reason
FROM jobs job
LEFT JOIN job_lifecycle_commands started
  ON started.job_id = job.id AND started.command_kind = 'START'
LEFT JOIN job_lifecycle_commands cancelled
  ON cancelled.job_id = job.id AND cancelled.command_kind = 'CANCEL'
LEFT JOIN LATERAL (
  SELECT id FROM job_completion_attempts attempt
  WHERE attempt.job_id = job.id ORDER BY attempt_number DESC LIMIT 1
) latest ON true
LEFT JOIN job_completion_decisions decision ON decision.attempt_id = latest.id;

CREATE FUNCTION job_completion_media_valid(target_job_id uuid, media_ids uuid[],
  expected_author_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT media_ids IS NOT NULL AND cardinality(media_ids) <= 10
    AND NOT EXISTS (SELECT 1 FROM unnest(media_ids) AS selected(media_id)
      WHERE selected.media_id IS NULL)
    AND (SELECT count(DISTINCT selected.media_id)
      FROM unnest(media_ids) AS selected(media_id)) = cardinality(media_ids)
    AND NOT EXISTS (
      SELECT 1 FROM unnest(media_ids) AS selected(media_id) WHERE NOT EXISTS (
        SELECT 1 FROM job_conversation_media media
        JOIN media_assets asset ON asset.id = media.media_asset_id
          AND asset.status = 'READY'
          AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
        JOIN media_asset_storage_objects canonical
          ON canonical.media_asset_id = asset.id AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private' AND canonical.revoked_at IS NULL
        WHERE media.job_id = target_job_id
          AND media.media_asset_id = selected.media_id
          AND media.uploaded_by_user_id = expected_author_id
          AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
            OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
              AND canonical.content_type = 'application/pdf'))
      )
    );
$$;

CREATE FUNCTION validate_job_completion_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_state job_state; next_number integer;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51014));
  IF EXISTS (SELECT 1 FROM job_completion_decisions WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'completion command ID collision';
  END IF;
  PERFORM 1 FROM users WHERE id = NEW.requested_by_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.requested_by_user_id FOR SHARE;
  SELECT state.state INTO actual_state FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.requested_by_user_id
    AND actor.id = provider.owner_user_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials auth ON auth.user_id = actor.id
    AND auth.email_verified_at IS NOT NULL AND auth.phone_verified_at IS NOT NULL
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  WHERE job.id = NEW.job_id;
  IF actual_state IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'active primary provider and IN_PROGRESS Job required';
  END IF;
  IF NOT job_completion_media_valid(NEW.job_id, NEW.final_media_asset_ids,
      NEW.requested_by_user_id) THEN
    RAISE EXCEPTION 'same-Job READY private provider media required';
  END IF;
  SELECT coalesce(max(attempt_number), 0) + 1 INTO next_number
    FROM job_completion_attempts WHERE job_id = NEW.job_id;
  IF NEW.attempt_number <> next_number THEN
    RAISE EXCEPTION 'next completion attempt number required';
  END IF;
  NEW.requested_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_completion_attempt_validate BEFORE INSERT ON job_completion_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_job_completion_attempt();

CREATE FUNCTION validate_job_completion_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; expected_actor_id uuid; actual_state job_state;
BEGIN
  SELECT job_id INTO target_job_id FROM job_completion_attempts WHERE id = NEW.attempt_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'completion attempt required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51014));
  IF EXISTS (SELECT 1 FROM job_completion_attempts WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'completion command ID collision';
  END IF;
  PERFORM 1 FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.actor_user_id FOR SHARE;
  SELECT CASE WHEN NEW.kind = 'WITHDRAW' THEN provider.owner_user_id
      ELSE customer.owner_user_id END, state.state
    INTO expected_actor_id, actual_state
  FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN users actor ON actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials auth ON auth.user_id = actor.id
    AND auth.email_verified_at IS NOT NULL AND auth.phone_verified_at IS NOT NULL
  WHERE job.id = target_job_id;
  IF expected_actor_id IS DISTINCT FROM NEW.actor_user_id
    OR actual_state IS DISTINCT FROM 'COMPLETION_REQUESTED'
    OR NEW.attempt_id IS DISTINCT FROM (
      SELECT id FROM job_completion_attempts WHERE job_id = target_job_id
      ORDER BY attempt_number DESC LIMIT 1
    ) THEN RAISE EXCEPTION 'exact pending completion attempt and party required'; END IF;
  IF NOT job_completion_media_valid(target_job_id, NEW.evidence_media_asset_ids,
      NEW.actor_user_id) THEN
    RAISE EXCEPTION 'same-Job READY private objection media required';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_completion_decision_validate BEFORE INSERT ON job_completion_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_job_completion_decision();

CREATE FUNCTION reject_job_completion_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'completion history is immutable'; END;
$$;
CREATE TRIGGER job_completion_attempt_immutable BEFORE UPDATE OR DELETE ON job_completion_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_job_completion_mutation();
CREATE TRIGGER job_completion_decision_immutable BEFORE UPDATE OR DELETE ON job_completion_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_job_completion_mutation();

CREATE FUNCTION notify_job_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; recipient_id uuid; attempt_id uuid;
  occurred_at timestamptz; event_kind text; source_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'job_completion_attempts' THEN
    target_job_id := NEW.job_id; attempt_id := NEW.id;
    occurred_at := NEW.requested_at; event_kind := 'job.completion.requested';
    source_id := NEW.id;
    SELECT customer.owner_user_id INTO recipient_id FROM jobs job
      JOIN customer_profiles customer ON customer.id = job.customer_profile_id
      WHERE job.id = target_job_id;
  ELSE
    attempt_id := NEW.attempt_id; source_id := NEW.id;
    SELECT attempt.job_id INTO target_job_id FROM job_completion_attempts attempt
      WHERE attempt.id = NEW.attempt_id;
    occurred_at := NEW.decided_at;
    event_kind := CASE NEW.kind WHEN 'ACCEPT' THEN 'job.completion.accepted'
      WHEN 'REJECT' THEN 'job.completion.rejected'
      ELSE 'job.completion.withdrawn' END;
    SELECT CASE WHEN NEW.kind = 'WITHDRAW' THEN customer.owner_user_id
      ELSE provider.owner_user_id END INTO recipient_id FROM jobs job
      JOIN customer_profiles customer ON customer.id = job.customer_profile_id
      JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
      WHERE job.id = target_job_id;
  END IF;
  IF recipient_id IS NULL THEN RAISE EXCEPTION 'completion notification recipient missing'; END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job.completion.' || source_id::text, event_kind, occurred_at,
    'JOB', target_job_id::text,
    jsonb_build_object('recipient_user_id', recipient_id::text,
      'job_id', target_job_id::text, 'attempt_id', attempt_id::text),
    event_kind, source_id::text, occurred_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_completion_attempt_notify AFTER INSERT ON job_completion_attempts
  FOR EACH ROW EXECUTE FUNCTION notify_job_completion();
CREATE TRIGGER job_completion_decision_notify AFTER INSERT ON job_completion_decisions
  FOR EACH ROW EXECUTE FUNCTION notify_job_completion();

CREATE VIEW job_completion_participant_closures AS
SELECT participant.id AS participant_id, participant.job_id,
  decision.decided_at AS closed_at, decision.actor_user_id AS closed_by_user_id,
  decision.id AS completion_decision_id
FROM current_job_participants participant
JOIN job_completion_attempts attempt ON attempt.job_id = participant.job_id
JOIN job_completion_decisions decision ON decision.attempt_id = attempt.id
  AND decision.kind = 'ACCEPT'
WHERE participant.state = 'ACCEPTED';

COMMENT ON TABLE job_completion_attempts IS
  'Immutable exact provider handover attempts, with central Job-media references.';
COMMENT ON TABLE job_completion_decisions IS
  'One immutable bilateral decision per attempt; customer accepts/rejects, provider may withdraw for resumed work.';
