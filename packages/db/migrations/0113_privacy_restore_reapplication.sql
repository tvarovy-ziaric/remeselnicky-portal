CREATE TYPE privacy_restore_reapplication_state AS ENUM (
  'PROCESSING', 'COMPLETED'
);

CREATE TYPE privacy_restore_reapplication_outcome AS ENUM (
  'APPLIED', 'ALREADY_APPLIED'
);

CREATE TABLE privacy_restore_reapplication_runs (
  run_id varchar(64) PRIMARY KEY CHECK (
    run_id ~ '^[a-z0-9][a-z0-9_-]{5,63}$'
  ),
  ledger_code varchar(64) NOT NULL CHECK (
    ledger_code ~ '^[a-z][a-z0-9.-]{1,63}$'
  ),
  ledger_sha256 char(64) NOT NULL CHECK (
    ledger_sha256 ~ '^[0-9a-f]{64}$'
  ),
  records_expected integer NOT NULL CHECK (
    records_expected BETWEEN 0 AND 100000
  ),
  state privacy_restore_reapplication_state NOT NULL DEFAULT 'PROCESSING',
  records_applied integer NOT NULL DEFAULT 0 CHECK (records_applied >= 0),
  records_already_applied integer NOT NULL DEFAULT 0 CHECK (
    records_already_applied >= 0
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT privacy_restore_run_shape CHECK (
    (
      state = 'PROCESSING'
      AND records_applied = 0
      AND records_already_applied = 0
      AND completed_at IS NULL
    ) OR (
      state = 'COMPLETED'
      AND records_applied + records_already_applied = records_expected
      AND completed_at IS NOT NULL
      AND completed_at >= started_at
    )
  )
);

CREATE TABLE privacy_restore_applied_tombstones (
  tombstone_id uuid PRIMARY KEY,
  source_disposition_event_id uuid NOT NULL UNIQUE CHECK (
    source_disposition_event_id = tombstone_id
  ),
  first_applied_run_id varchar(64) NOT NULL
    REFERENCES privacy_restore_reapplication_runs(run_id) ON DELETE RESTRICT,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category privacy_retention_category NOT NULL,
  disposition privacy_data_disposition NOT NULL CHECK (
    disposition IN ('DELETE', 'ANONYMIZE')
  ),
  policy_version_id uuid NOT NULL,
  ledger_receipt_digest char(64) NOT NULL UNIQUE CHECK (
    ledger_receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  source_created_at timestamptz NOT NULL,
  affected_record_count integer NOT NULL CHECK (
    affected_record_count >= 0
  ),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE privacy_restore_reapplication_items (
  run_id varchar(64) NOT NULL
    REFERENCES privacy_restore_reapplication_runs(run_id) ON DELETE RESTRICT,
  tombstone_id uuid NOT NULL
    REFERENCES privacy_restore_applied_tombstones(tombstone_id)
    ON DELETE RESTRICT,
  outcome privacy_restore_reapplication_outcome NOT NULL,
  affected_record_count integer NOT NULL CHECK (
    affected_record_count >= 0
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, tombstone_id)
);

CREATE FUNCTION assert_privacy_restore_database_owner()
RETURNS void LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp AS $$
DECLARE database_owner name;
BEGIN
  SELECT role.rolname INTO database_owner
  FROM pg_database database
  JOIN pg_roles role ON role.oid = database.datdba
  WHERE database.datname = current_database();
  IF database_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'privacy restore requires the isolated database owner';
  END IF;
END;
$$;

CREATE FUNCTION validate_privacy_restore_run()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE applied_count integer;
DECLARE already_count integer;
BEGIN
  PERFORM assert_privacy_restore_database_owner();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'privacy restore history is immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.state := 'PROCESSING';
    NEW.records_applied := 0;
    NEW.records_already_applied := 0;
    NEW.started_at := clock_timestamp();
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'PROCESSING'
    OR NEW.state <> 'COMPLETED'
    OR NEW.run_id <> OLD.run_id
    OR NEW.ledger_code <> OLD.ledger_code
    OR NEW.ledger_sha256 <> OLD.ledger_sha256
    OR NEW.records_expected <> OLD.records_expected
    OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'invalid privacy restore run transition';
  END IF;
  SELECT
    count(*) FILTER (WHERE outcome = 'APPLIED')::integer,
    count(*) FILTER (WHERE outcome = 'ALREADY_APPLIED')::integer
  INTO applied_count, already_count
  FROM privacy_restore_reapplication_items
  WHERE run_id = OLD.run_id;
  IF applied_count + already_count <> OLD.records_expected
    OR NEW.records_applied <> applied_count
    OR NEW.records_already_applied <> already_count THEN
    RAISE EXCEPTION 'privacy restore run item count mismatch';
  END IF;
  NEW.completed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_restore_runs_guard
BEFORE INSERT OR UPDATE OR DELETE ON privacy_restore_reapplication_runs
FOR EACH ROW EXECUTE FUNCTION validate_privacy_restore_run();

CREATE FUNCTION apply_privacy_restore_tombstone_effect()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE run_state privacy_restore_reapplication_state;
DECLARE affected integer;
BEGIN
  PERFORM assert_privacy_restore_database_owner();
  SELECT state INTO run_state
  FROM privacy_restore_reapplication_runs
  WHERE run_id = NEW.first_applied_run_id
  FOR UPDATE;
  IF run_state IS DISTINCT FROM 'PROCESSING' THEN
    RAISE EXCEPTION 'processing privacy restore run required';
  END IF;
  IF NEW.category = 'NOTIFICATION_DELIVERY'
    AND NEW.disposition = 'DELETE' THEN
    DELETE FROM notification_deliveries delivery
    USING notifications notification
    WHERE delivery.notification_id = notification.id
      AND notification.recipient_user_id = NEW.subject_user_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unsupported privacy restore tombstone category';
  END IF;
  NEW.affected_record_count := affected;
  NEW.applied_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_restore_applied_tombstone_effect
BEFORE INSERT ON privacy_restore_applied_tombstones
FOR EACH ROW EXECUTE FUNCTION apply_privacy_restore_tombstone_effect();

CREATE FUNCTION reject_privacy_restore_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy restore history is immutable';
END;
$$;

CREATE TRIGGER privacy_restore_applied_tombstones_immutable
BEFORE UPDATE OR DELETE ON privacy_restore_applied_tombstones
FOR EACH ROW EXECUTE FUNCTION reject_privacy_restore_history_mutation();

CREATE FUNCTION validate_privacy_restore_item()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE run_state privacy_restore_reapplication_state;
DECLARE applied privacy_restore_applied_tombstones%ROWTYPE;
BEGIN
  PERFORM assert_privacy_restore_database_owner();
  SELECT state INTO run_state
  FROM privacy_restore_reapplication_runs
  WHERE run_id = NEW.run_id
  FOR UPDATE;
  SELECT * INTO applied
  FROM privacy_restore_applied_tombstones
  WHERE tombstone_id = NEW.tombstone_id
  FOR SHARE;
  IF run_state IS DISTINCT FROM 'PROCESSING'
    OR applied.tombstone_id IS NULL THEN
    RAISE EXCEPTION 'processing run and applied tombstone required';
  END IF;
  NEW.outcome := CASE
    WHEN applied.first_applied_run_id = NEW.run_id THEN 'APPLIED'
    ELSE 'ALREADY_APPLIED'
  END;
  NEW.affected_record_count := CASE
    WHEN NEW.outcome = 'APPLIED' THEN applied.affected_record_count
    ELSE 0
  END;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_restore_items_guard
BEFORE INSERT ON privacy_restore_reapplication_items
FOR EACH ROW EXECUTE FUNCTION validate_privacy_restore_item();

CREATE TRIGGER privacy_restore_items_immutable
BEFORE UPDATE OR DELETE ON privacy_restore_reapplication_items
FOR EACH ROW EXECUTE FUNCTION reject_privacy_restore_history_mutation();

CREATE FUNCTION begin_privacy_restore_reapplication(
  target_run_id varchar(64),
  target_ledger_code varchar(64),
  target_ledger_sha256 char(64),
  target_records_expected integer
)
RETURNS privacy_restore_reapplication_runs
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE result privacy_restore_reapplication_runs%ROWTYPE;
BEGIN
  PERFORM assert_privacy_restore_database_owner();
  INSERT INTO privacy_restore_reapplication_runs (
    run_id, ledger_code, ledger_sha256, records_expected
  ) VALUES (
    target_run_id, target_ledger_code, target_ledger_sha256,
    target_records_expected
  )
  ON CONFLICT (run_id) DO NOTHING;
  SELECT * INTO result FROM privacy_restore_reapplication_runs
  WHERE run_id = target_run_id FOR UPDATE;
  IF result.ledger_code <> target_ledger_code
    OR result.ledger_sha256 <> target_ledger_sha256
    OR result.records_expected <> target_records_expected
    OR result.state <> 'PROCESSING' THEN
    RAISE EXCEPTION 'privacy restore run identity conflict';
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION apply_privacy_restore_tombstone(
  target_run_id varchar(64),
  target_tombstone_id uuid,
  target_source_event_id uuid,
  target_subject_user_id uuid,
  target_category privacy_retention_category,
  target_disposition privacy_data_disposition,
  target_policy_version_id uuid,
  target_receipt_digest char(64),
  target_source_created_at timestamptz
)
RETURNS privacy_restore_reapplication_items
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE applied privacy_restore_applied_tombstones%ROWTYPE;
DECLARE item privacy_restore_reapplication_items%ROWTYPE;
BEGIN
  PERFORM assert_privacy_restore_database_owner();
  IF target_tombstone_id <> target_source_event_id THEN
    RAISE EXCEPTION 'privacy restore tombstone identity mismatch';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(target_tombstone_id::text, 0)
  );
  SELECT * INTO applied FROM privacy_restore_applied_tombstones
  WHERE tombstone_id = target_tombstone_id;
  IF applied.tombstone_id IS NULL THEN
    INSERT INTO privacy_restore_applied_tombstones (
      tombstone_id, source_disposition_event_id, first_applied_run_id,
      subject_user_id, category, disposition, policy_version_id,
      ledger_receipt_digest, source_created_at, affected_record_count
    ) VALUES (
      target_tombstone_id, target_source_event_id, target_run_id,
      target_subject_user_id, target_category, target_disposition,
      target_policy_version_id, target_receipt_digest,
      target_source_created_at, 0
    ) RETURNING * INTO applied;
  ELSIF applied.source_disposition_event_id <> target_source_event_id
    OR applied.subject_user_id <> target_subject_user_id
    OR applied.category <> target_category
    OR applied.disposition <> target_disposition
    OR applied.policy_version_id <> target_policy_version_id
    OR applied.ledger_receipt_digest <> target_receipt_digest
    OR applied.source_created_at <> target_source_created_at THEN
    RAISE EXCEPTION 'privacy restore tombstone identity conflict';
  END IF;

  INSERT INTO privacy_restore_reapplication_items (
    run_id, tombstone_id, outcome, affected_record_count
  ) VALUES (
    target_run_id, target_tombstone_id, 'ALREADY_APPLIED', 0
  ) ON CONFLICT (run_id, tombstone_id) DO NOTHING;
  SELECT * INTO item FROM privacy_restore_reapplication_items
  WHERE run_id = target_run_id AND tombstone_id = target_tombstone_id;
  RETURN item;
END;
$$;

CREATE FUNCTION complete_privacy_restore_reapplication(target_run_id varchar(64))
RETURNS privacy_restore_reapplication_runs
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE applied_count integer;
DECLARE already_count integer;
DECLARE result privacy_restore_reapplication_runs%ROWTYPE;
BEGIN
  PERFORM assert_privacy_restore_database_owner();
  SELECT
    count(*) FILTER (WHERE outcome = 'APPLIED')::integer,
    count(*) FILTER (WHERE outcome = 'ALREADY_APPLIED')::integer
  INTO applied_count, already_count
  FROM privacy_restore_reapplication_items
  WHERE run_id = target_run_id;
  UPDATE privacy_restore_reapplication_runs
  SET state = 'COMPLETED', records_applied = applied_count,
    records_already_applied = already_count
  WHERE run_id = target_run_id AND state = 'PROCESSING'
  RETURNING * INTO result;
  IF result.run_id IS NULL THEN
    RAISE EXCEPTION 'processing privacy restore run required';
  END IF;
  RETURN result;
END;
$$;

COMMENT ON TABLE privacy_restore_reapplication_runs IS
  'Content-free disaster-recovery replay attestation; completion requires one exact item per normalized independent-ledger tombstone.';
COMMENT ON TABLE privacy_restore_applied_tombstones IS
  'Immutable idempotency receipts for category effects reapplied after restore; no request content, addresses, messages, provider references or raw receipts.';
COMMENT ON TABLE privacy_restore_reapplication_items IS
  'Per-run proof that every normalized tombstone was newly applied or already present; unsupported categories fail the transaction.';

REVOKE ALL ON privacy_restore_reapplication_runs FROM PUBLIC;
REVOKE ALL ON privacy_restore_applied_tombstones FROM PUBLIC;
REVOKE ALL ON privacy_restore_reapplication_items FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assert_privacy_restore_database_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION begin_privacy_restore_reapplication(
  varchar, varchar, char, integer
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_privacy_restore_tombstone(
  varchar, uuid, uuid, uuid, privacy_retention_category,
  privacy_data_disposition, uuid, char, timestamptz
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_privacy_restore_reapplication(
  varchar
) FROM PUBLIC;
