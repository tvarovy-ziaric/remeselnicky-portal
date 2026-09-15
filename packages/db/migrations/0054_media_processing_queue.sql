CREATE TYPE media_processing_job_state AS ENUM (
  'PENDING', 'PROCESSING', 'SUCCEEDED', 'TERMINAL'
);
CREATE TYPE media_processing_terminal_reason AS ENUM (
  'NON_RETRYABLE', 'RETRIES_EXHAUSTED'
);

CREATE TABLE media_processing_jobs (
  asset_id uuid PRIMARY KEY REFERENCES media_assets(id) ON DELETE RESTRICT,
  kind media_kind NOT NULL,
  state media_processing_job_state NOT NULL DEFAULT 'PENDING',
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
  terminal_reason media_processing_terminal_reason,
  terminal_run_id text,
  terminal_at timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_processing_job_error_safe CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'
  ),
  CONSTRAINT media_processing_job_run_safe CHECK (
    terminal_run_id IS NULL
    OR terminal_run_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  ),
  CONSTRAINT media_processing_job_shape CHECK (
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

CREATE INDEX media_processing_jobs_claim_idx
ON media_processing_jobs (available_at, enqueued_at, asset_id)
WHERE state = 'PENDING';
CREATE INDEX media_processing_jobs_reclaim_idx
ON media_processing_jobs (lease_expires_at, asset_id)
WHERE state = 'PROCESSING';

CREATE FUNCTION validate_media_processing_job_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asset_kind media_kind;
DECLARE asset_status media_asset_status;
BEGIN
  SELECT asset.kind, asset.status
  INTO asset_kind, asset_status
  FROM media_assets asset
  WHERE asset.id = NEW.asset_id
  FOR UPDATE;
  IF NOT FOUND OR asset_status <> 'PROCESSING' OR asset_kind <> NEW.kind THEN
    RAISE EXCEPTION 'media processing job requires exact processing asset';
  END IF;
  NEW.state := 'PENDING';
  NEW.attempt_count := 0;
  NEW.failed_attempt_count := 0;
  NEW.retry_count := 0;
  NEW.max_attempts := 10;
  NEW.available_at := clock_timestamp();
  NEW.lease_token := NULL;
  NEW.lease_expires_at := NULL;
  NEW.last_error_code := NULL;
  NEW.completed_at := NULL;
  NEW.terminal_reason := NULL;
  NEW.terminal_run_id := NULL;
  NEW.terminal_at := NULL;
  NEW.enqueued_at := clock_timestamp();
  NEW.updated_at := NEW.enqueued_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_processing_jobs_insert_guard
BEFORE INSERT ON media_processing_jobs
FOR EACH ROW EXECUTE FUNCTION validate_media_processing_job_insert();

CREATE FUNCTION validate_media_processing_job_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_id <> OLD.asset_id
    OR NEW.kind <> OLD.kind
    OR NEW.max_attempts <> OLD.max_attempts
    OR NEW.enqueued_at <> OLD.enqueued_at
  THEN
    RAISE EXCEPTION 'media processing job identity is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'PENDING' AND NEW.state = 'PROCESSING')
    OR (OLD.state = 'PROCESSING' AND NEW.state IN (
      'PENDING', 'PROCESSING', 'SUCCEEDED', 'TERMINAL'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid media processing job transition';
  END IF;
  IF NEW.state = 'PROCESSING' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count
      OR NEW.retry_count <> OLD.retry_count
    THEN
      RAISE EXCEPTION 'media processing claim has invalid counters';
    END IF;
    IF NEW.lease_expires_at <= clock_timestamp()
      OR NEW.lease_expires_at > clock_timestamp() + interval '5 minutes'
    THEN
      RAISE EXCEPTION 'media processing lease is outside its bounded window';
    END IF;
  ELSIF NEW.state = 'PENDING' THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count + 1
      OR NEW.retry_count <> OLD.retry_count + 1
    THEN
      RAISE EXCEPTION 'media processing retry has invalid counters';
    END IF;
  ELSIF NEW.state = 'SUCCEEDED' THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count
      OR NEW.retry_count <> OLD.retry_count
    THEN
      RAISE EXCEPTION 'media processing success has invalid counters';
    END IF;
  ELSIF NEW.state = 'TERMINAL' THEN
    IF NEW.attempt_count <> OLD.attempt_count
      OR NEW.failed_attempt_count <> OLD.failed_attempt_count + 1
      OR NEW.retry_count <> OLD.retry_count
    THEN
      RAISE EXCEPTION 'media processing terminal result has invalid counters';
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
CREATE TRIGGER media_processing_jobs_update_guard
BEFORE UPDATE ON media_processing_jobs
FOR EACH ROW EXECUTE FUNCTION validate_media_processing_job_update();

CREATE FUNCTION reject_media_processing_job_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media processing jobs cannot be deleted';
END;
$$;
CREATE TRIGGER media_processing_jobs_delete_guard
BEFORE DELETE ON media_processing_jobs
FOR EACH ROW EXECUTE FUNCTION reject_media_processing_job_delete();

INSERT INTO media_processing_jobs (asset_id, kind)
SELECT asset.id, asset.kind
FROM media_assets asset
WHERE asset.status = 'PROCESSING'
ON CONFLICT (asset_id) DO NOTHING;

CREATE FUNCTION enqueue_media_asset_processing_job()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO media_processing_jobs (asset_id, kind)
  VALUES (NEW.id, NEW.kind);
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_assets_processing_job_capture
AFTER INSERT ON media_assets
FOR EACH ROW
WHEN (NEW.status = 'PROCESSING')
EXECUTE FUNCTION enqueue_media_asset_processing_job();
