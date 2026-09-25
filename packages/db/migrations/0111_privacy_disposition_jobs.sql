CREATE TYPE privacy_disposition_job_state AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'TERMINAL'
);

CREATE TYPE privacy_disposition_job_terminal_reason AS ENUM (
  'NON_RETRYABLE', 'RETRIES_EXHAUSTED'
);

CREATE TABLE privacy_recovery_tombstones (
  tombstone_id uuid PRIMARY KEY,
  source_disposition_event_id uuid NOT NULL UNIQUE
    REFERENCES privacy_data_disposition_events(event_id) ON DELETE RESTRICT,
  case_id uuid NOT NULL
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category privacy_retention_category NOT NULL,
  disposition privacy_data_disposition NOT NULL CHECK (
    disposition IN ('DELETE', 'ANONYMIZE')
  ),
  policy_version_id uuid NOT NULL
    REFERENCES privacy_retention_policy_versions(policy_version_id)
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE privacy_recovery_tombstone_receipts (
  tombstone_id uuid PRIMARY KEY
    REFERENCES privacy_recovery_tombstones(tombstone_id) ON DELETE RESTRICT,
  ledger_code text NOT NULL CHECK (
    ledger_code ~ '^[a-z][a-z0-9.-]{1,63}$'
  ),
  receipt_digest char(64) NOT NULL UNIQUE CHECK (
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE privacy_data_disposition_jobs (
  job_id uuid PRIMARY KEY,
  source_disposition_event_id uuid NOT NULL UNIQUE
    REFERENCES privacy_data_disposition_events(event_id) ON DELETE RESTRICT,
  tombstone_id uuid NOT NULL UNIQUE
    REFERENCES privacy_recovery_tombstones(tombstone_id) ON DELETE RESTRICT,
  case_id uuid NOT NULL
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category privacy_retention_category NOT NULL,
  disposition privacy_data_disposition NOT NULL CHECK (
    disposition IN ('DELETE', 'ANONYMIZE')
  ),
  policy_version_id uuid NOT NULL
    REFERENCES privacy_retention_policy_versions(policy_version_id)
    ON DELETE RESTRICT,
  state privacy_disposition_job_state NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failed_attempt_count integer NOT NULL DEFAULT 0 CHECK (
    failed_attempt_count >= 0
  ),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_attempts integer NOT NULL DEFAULT 10 CHECK (
    max_attempts >= 1 AND max_attempts <= 100
  ),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  terminal_reason privacy_disposition_job_terminal_reason,
  terminal_run_id text,
  terminal_at timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_disposition_job_identity_matches CHECK (
    job_id = source_disposition_event_id
    AND tombstone_id = source_disposition_event_id
  ),
  CONSTRAINT privacy_disposition_job_error_safe CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'
  ),
  CONSTRAINT privacy_disposition_job_run_safe CHECK (
    terminal_run_id IS NULL
    OR terminal_run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  ),
  CONSTRAINT privacy_disposition_job_shape CHECK (
    (
      state = 'PENDING'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NULL
      AND terminal_reason IS NULL
      AND terminal_run_id IS NULL
      AND terminal_at IS NULL
    ) OR (
      state = 'PROCESSING'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL
      AND terminal_reason IS NULL
      AND terminal_run_id IS NULL
      AND terminal_at IS NULL
    ) OR (
      state = 'SUCCEEDED'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND last_error_code IS NULL
      AND completed_at IS NOT NULL
      AND terminal_reason IS NULL
      AND terminal_run_id IS NULL
      AND terminal_at IS NULL
    ) OR (
      state = 'TERMINAL'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND last_error_code IS NOT NULL
      AND completed_at IS NULL
      AND terminal_reason IS NOT NULL
      AND terminal_run_id IS NOT NULL
      AND terminal_at IS NOT NULL
    )
  )
);

CREATE INDEX privacy_disposition_jobs_claim_idx
ON privacy_data_disposition_jobs (available_at, enqueued_at, job_id)
WHERE state = 'PENDING';

CREATE INDEX privacy_disposition_jobs_reclaim_idx
ON privacy_data_disposition_jobs (lease_expires_at, job_id)
WHERE state = 'PROCESSING';

CREATE FUNCTION validate_privacy_disposition_job_insert()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE source_event privacy_data_disposition_events%ROWTYPE;
DECLARE tombstone privacy_recovery_tombstones%ROWTYPE;
BEGIN
  SELECT * INTO source_event
  FROM privacy_data_disposition_events
  WHERE event_id = NEW.source_disposition_event_id
  FOR SHARE;
  SELECT * INTO tombstone
  FROM privacy_recovery_tombstones
  WHERE tombstone_id = NEW.tombstone_id
  FOR SHARE;

  IF source_event.event_id IS NULL
    OR tombstone.tombstone_id IS NULL
    OR source_event.event_id <> tombstone.source_disposition_event_id
    OR source_event.event_id <> NEW.job_id
    OR source_event.case_id <> NEW.case_id
    OR source_event.category <> NEW.category
    OR source_event.disposition <> NEW.disposition
    OR source_event.policy_version_id <> NEW.policy_version_id
    OR source_event.state <> 'READY'
    OR source_event.disposition_admin_command_id IS NULL
    OR tombstone.case_id <> NEW.case_id
    OR tombstone.subject_user_id <> NEW.subject_user_id
    OR tombstone.category <> NEW.category
    OR tombstone.disposition <> NEW.disposition
    OR tombstone.policy_version_id <> NEW.policy_version_id
    OR NEW.max_attempts <> 10 THEN
    RAISE EXCEPTION 'privacy disposition job must exactly match its reviewed tombstone';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_disposition_jobs_insert_guard
BEFORE INSERT ON privacy_data_disposition_jobs
FOR EACH ROW EXECUTE FUNCTION validate_privacy_disposition_job_insert();

ALTER TABLE privacy_data_disposition_events
  DROP CONSTRAINT privacy_disposition_command_provenance,
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN actor_system_reference text,
  ADD COLUMN disposition_job_id uuid
    REFERENCES privacy_data_disposition_jobs(job_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT privacy_disposition_actor_shape CHECK (
    (
      actor_user_id IS NOT NULL
      AND actor_system_reference IS NULL
    ) OR (
      actor_user_id IS NULL
      AND actor_system_reference IS NOT NULL
      AND actor_system_reference
        ~ '^privacy[.]worker:[0-9a-f-]{36}$'
    )
  ),
  ADD CONSTRAINT privacy_disposition_command_provenance CHECK (
    (
      revision = 1
      AND disposition = 'REVIEW_REQUIRED'
      AND state = 'BLOCKED'
      AND disposition_admin_command_id IS NULL
      AND disposition_job_id IS NULL
      AND actor_user_id IS NOT NULL
    ) OR (
      revision > 1
      AND disposition <> 'REVIEW_REQUIRED'
      AND disposition_admin_command_id IS NOT NULL
      AND disposition_job_id IS NULL
      AND actor_user_id IS NOT NULL
    ) OR (
      revision > 1
      AND disposition IN ('DELETE', 'ANONYMIZE')
      AND disposition_admin_command_id IS NULL
      AND disposition_job_id IS NOT NULL
      AND actor_user_id IS NULL
    )
  );

CREATE OR REPLACE VIEW current_privacy_data_dispositions
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (event.case_id, event.category)
  event.event_id, event.case_id, event.category, event.revision,
  event.disposition, event.state, event.policy_version_id,
  event.actor_user_id, event.action_code, event.occurred_at,
  event.actor_system_reference, event.disposition_admin_command_id,
  event.disposition_job_id
FROM privacy_data_disposition_events event
ORDER BY event.case_id, event.category, event.revision DESC;

CREATE FUNCTION capture_privacy_disposition_job()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE subject_id uuid;
BEGIN
  IF NEW.state <> 'READY'
    OR NEW.disposition NOT IN ('DELETE', 'ANONYMIZE')
    OR NEW.disposition_admin_command_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT request.subject_user_id INTO subject_id
  FROM privacy_request_cases request
  WHERE request.case_id = NEW.case_id;
  IF subject_id IS NULL THEN
    RAISE EXCEPTION 'privacy disposition subject is required';
  END IF;

  INSERT INTO privacy_recovery_tombstones (
    tombstone_id, source_disposition_event_id, case_id, subject_user_id,
    category, disposition, policy_version_id, created_at
  ) VALUES (
    NEW.event_id, NEW.event_id, NEW.case_id, subject_id,
    NEW.category, NEW.disposition, NEW.policy_version_id, NEW.occurred_at
  );

  INSERT INTO privacy_data_disposition_jobs (
    job_id, source_disposition_event_id, tombstone_id, case_id,
    subject_user_id, category, disposition, policy_version_id,
    enqueued_at, updated_at, available_at
  ) VALUES (
    NEW.event_id, NEW.event_id, NEW.event_id, NEW.case_id,
    subject_id, NEW.category, NEW.disposition, NEW.policy_version_id,
    NEW.occurred_at, NEW.occurred_at, NEW.occurred_at
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER privacy_disposition_job_capture
AFTER INSERT ON privacy_data_disposition_events
FOR EACH ROW EXECUTE FUNCTION capture_privacy_disposition_job();

-- Upgrade safety: 0110 may already contain a current reviewed destructive
-- decision. Backfill only the current READY head; obsolete historical READY
-- revisions must never become newly executable work.
INSERT INTO privacy_recovery_tombstones (
  tombstone_id, source_disposition_event_id, case_id, subject_user_id,
  category, disposition, policy_version_id, created_at
)
SELECT current.event_id, current.event_id, current.case_id,
  request.subject_user_id, current.category, current.disposition,
  current.policy_version_id, current.occurred_at
FROM current_privacy_data_dispositions current
JOIN privacy_request_cases request ON request.case_id = current.case_id
WHERE current.state = 'READY'
  AND current.disposition IN ('DELETE', 'ANONYMIZE')
  AND current.disposition_admin_command_id IS NOT NULL
ON CONFLICT (tombstone_id) DO NOTHING;

INSERT INTO privacy_data_disposition_jobs (
  job_id, source_disposition_event_id, tombstone_id, case_id,
  subject_user_id, category, disposition, policy_version_id,
  enqueued_at, updated_at, available_at
)
SELECT tombstone.tombstone_id, tombstone.source_disposition_event_id,
  tombstone.tombstone_id, tombstone.case_id, tombstone.subject_user_id,
  tombstone.category, tombstone.disposition, tombstone.policy_version_id,
  tombstone.created_at, tombstone.created_at, tombstone.created_at
FROM privacy_recovery_tombstones tombstone
JOIN current_privacy_data_dispositions current
  ON current.event_id = tombstone.source_disposition_event_id
WHERE current.state = 'READY'
  AND current.disposition IN ('DELETE', 'ANONYMIZE')
  AND current.disposition_admin_command_id IS NOT NULL
ON CONFLICT (job_id) DO NOTHING;

CREATE FUNCTION validate_privacy_disposition_job_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.job_id <> OLD.job_id
    OR NEW.source_disposition_event_id <> OLD.source_disposition_event_id
    OR NEW.tombstone_id <> OLD.tombstone_id
    OR NEW.case_id <> OLD.case_id
    OR NEW.subject_user_id <> OLD.subject_user_id
    OR NEW.category <> OLD.category
    OR NEW.disposition <> OLD.disposition
    OR NEW.policy_version_id <> OLD.policy_version_id
    OR NEW.max_attempts <> OLD.max_attempts
    OR NEW.enqueued_at <> OLD.enqueued_at THEN
    RAISE EXCEPTION 'privacy disposition job identity is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'PENDING' AND NEW.state = 'PROCESSING')
    OR (OLD.state = 'PROCESSING' AND NEW.state IN (
      'PENDING', 'PROCESSING', 'SUCCEEDED', 'TERMINAL'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid privacy disposition job transition';
  END IF;
  IF NEW.state = 'PROCESSING' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.attempt_count > NEW.max_attempts
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count
      OR NEW.retry_count <> OLD.retry_count
      OR NEW.last_error_code IS NOT NULL
      OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'privacy disposition claim has invalid counters';
    END IF;
    IF NEW.lease_expires_at <= clock_timestamp()
      OR NEW.lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'privacy disposition lease is outside its bounded window';
    END IF;
  ELSIF NEW.state = 'PENDING' THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count + 1
      OR NEW.retry_count <> OLD.retry_count + 1
      OR NEW.last_error_code IS NULL THEN
      RAISE EXCEPTION 'privacy disposition retry has invalid counters';
    END IF;
  ELSIF NEW.state = 'SUCCEEDED' THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count
      OR NEW.retry_count <> OLD.retry_count THEN
      RAISE EXCEPTION 'privacy disposition success has invalid counters';
    END IF;
  ELSIF NEW.state = 'TERMINAL' THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count + 1
      OR NEW.retry_count <> OLD.retry_count THEN
      RAISE EXCEPTION 'privacy disposition terminal result has invalid counters';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  IF NEW.state = 'SUCCEEDED' THEN
    NEW.completed_at := NEW.updated_at;
    NEW.terminal_at := NULL;
  ELSIF NEW.state = 'TERMINAL' THEN
    NEW.completed_at := NULL;
    NEW.terminal_at := NEW.updated_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_disposition_jobs_update_guard
BEFORE UPDATE ON privacy_data_disposition_jobs
FOR EACH ROW EXECUTE FUNCTION validate_privacy_disposition_job_update();

CREATE FUNCTION validate_privacy_disposition_worker_event()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE job privacy_data_disposition_jobs%ROWTYPE;
DECLARE previous_event privacy_data_disposition_events%ROWTYPE;
BEGIN
  IF NEW.disposition_job_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO job
  FROM privacy_data_disposition_jobs
  WHERE job_id = NEW.disposition_job_id
  FOR SHARE;
  IF NOT FOUND
    OR job.case_id <> NEW.case_id
    OR job.category <> NEW.category
    OR job.disposition <> NEW.disposition
    OR job.policy_version_id <> NEW.policy_version_id
    OR NEW.actor_system_reference
      <> 'privacy.worker:' || job.job_id::text THEN
    RAISE EXCEPTION 'privacy worker event does not match its exact job';
  END IF;

  SELECT * INTO previous_event
  FROM privacy_data_disposition_events
  WHERE case_id = NEW.case_id AND category = NEW.category
  ORDER BY revision DESC LIMIT 1
  FOR UPDATE;
  IF previous_event.event_id IS NULL
    OR NEW.revision <> previous_event.revision + 1
    OR NEW.disposition <> previous_event.disposition
    OR NEW.policy_version_id <> previous_event.policy_version_id THEN
    RAISE EXCEPTION 'privacy worker event has stale category state';
  END IF;

  IF NEW.state = 'PROCESSING' THEN
    IF previous_event.state NOT IN ('READY', 'FAILED', 'PROCESSING')
      OR job.state <> 'PROCESSING'
      OR NEW.action_code <> 'PRIVACY_DISPOSITION_PROCESSING' THEN
      RAISE EXCEPTION 'invalid privacy worker processing transition';
    END IF;
  ELSIF NEW.state = 'FAILED' THEN
    IF previous_event.state <> 'PROCESSING'
      OR job.state NOT IN ('PENDING', 'TERMINAL')
      OR NEW.action_code <> 'PRIVACY_DISPOSITION_FAILED' THEN
      RAISE EXCEPTION 'invalid privacy worker failure transition';
    END IF;
  ELSIF NEW.state = 'COMPLETED' THEN
    IF previous_event.state <> 'PROCESSING'
      OR job.state <> 'SUCCEEDED'
      OR NEW.action_code <> 'PRIVACY_DISPOSITION_COMPLETED' THEN
      RAISE EXCEPTION 'invalid privacy worker completion transition';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid privacy worker state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_data_disposition_worker_validate
BEFORE INSERT ON privacy_data_disposition_events
FOR EACH ROW EXECUTE FUNCTION validate_privacy_disposition_worker_event();

CREATE TRIGGER privacy_recovery_tombstones_immutable
BEFORE UPDATE OR DELETE ON privacy_recovery_tombstones
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

CREATE TRIGGER privacy_recovery_tombstone_receipts_immutable
BEFORE UPDATE OR DELETE ON privacy_recovery_tombstone_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

CREATE FUNCTION reject_privacy_disposition_job_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy disposition jobs cannot be deleted';
END;
$$;

CREATE TRIGGER privacy_disposition_jobs_delete_guard
BEFORE DELETE ON privacy_data_disposition_jobs
FOR EACH ROW EXECUTE FUNCTION reject_privacy_disposition_job_delete();

COMMENT ON TABLE privacy_recovery_tombstones IS
  'Append-only deletion/anonymization intent that must be durably copied to an independent recovery ledger before its worker job becomes claimable.';
COMMENT ON TABLE privacy_recovery_tombstone_receipts IS
  'Digest-only acknowledgements from a provider-neutral independent recovery ledger. The runtime must never self-acknowledge these receipts.';
COMMENT ON TABLE privacy_data_disposition_jobs IS
  'Lease-based, resumable per-category destructive privacy work. No job is claimable without an independent recovery-tombstone receipt.';
