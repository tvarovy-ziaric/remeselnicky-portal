CREATE TABLE privacy_category_execution_receipts (
  job_id uuid PRIMARY KEY
    REFERENCES privacy_data_disposition_jobs(job_id) ON DELETE RESTRICT,
  category privacy_retention_category NOT NULL,
  disposition privacy_data_disposition NOT NULL CHECK (
    disposition IN ('DELETE', 'ANONYMIZE')
  ),
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  executor_code text NOT NULL CHECK (
    executor_code ~ '^[a-z][a-z0-9.-]{2,95}$'
  ),
  execution_attempt integer NOT NULL CHECK (execution_attempt >= 1),
  affected_record_count integer NOT NULL CHECK (affected_record_count >= 0),
  result_digest char(64) NOT NULL CHECK (
    result_digest ~ '^[0-9a-f]{64}$'
  ),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_privacy_category_execution_receipt()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE job privacy_data_disposition_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job
  FROM privacy_data_disposition_jobs
  WHERE job_id = NEW.job_id
  FOR SHARE;
  IF job.job_id IS NULL
    OR job.state <> 'PROCESSING'
    OR job.category <> NEW.category
    OR job.disposition <> NEW.disposition
    OR job.subject_user_id <> NEW.subject_user_id
    OR job.attempt_count <> NEW.execution_attempt THEN
    RAISE EXCEPTION 'privacy execution receipt does not match its active job';
  END IF;
  IF NEW.category = 'NOTIFICATION_DELIVERY'
    AND NEW.executor_code <> 'postgres.notification-delivery.v1' THEN
    RAISE EXCEPTION 'notification delivery disposition executor mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_category_execution_receipt_validate
BEFORE INSERT ON privacy_category_execution_receipts
FOR EACH ROW EXECUTE FUNCTION validate_privacy_category_execution_receipt();

CREATE TRIGGER privacy_category_execution_receipts_immutable
BEFORE UPDATE OR DELETE ON privacy_category_execution_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

COMMENT ON TABLE privacy_category_execution_receipts IS
  'Append-only idempotency proof for a completed category transformation. It contains counts and a deterministic digest, never deleted personal content.';

