CREATE TABLE privacy_data_disposition_admin_commands (
  command_id uuid PRIMARY KEY,
  case_id uuid NOT NULL
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  category privacy_retention_category NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL CHECK (
    actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
  ),
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  expected_disposition privacy_data_disposition NOT NULL,
  expected_state privacy_disposition_state NOT NULL,
  resulting_revision integer NOT NULL,
  resulting_disposition privacy_data_disposition NOT NULL CHECK (
    resulting_disposition <> 'REVIEW_REQUIRED'
  ),
  resulting_state privacy_disposition_state NOT NULL,
  policy_version_id uuid NOT NULL
    REFERENCES privacy_retention_policy_versions(policy_version_id)
    ON DELETE RESTRICT,
  action_code text NOT NULL CHECK (
    action_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  reason text NOT NULL CHECK (audit_reason_is_safe(reason)),
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  audit_event_id uuid NOT NULL UNIQUE
    REFERENCES audit_events(event_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_disposition_admin_revision_step CHECK (
    resulting_revision = expected_revision + 1
  ),
  CONSTRAINT privacy_disposition_admin_state_shape CHECK (
    (
      resulting_disposition IN ('DELETE', 'ANONYMIZE')
      AND resulting_state = 'READY'
    ) OR (
      resulting_disposition IN ('RETAIN', 'NO_DATA')
      AND resulting_state = 'COMPLETED'
    )
  )
);

ALTER TABLE privacy_data_disposition_events
  ADD COLUMN disposition_admin_command_id uuid UNIQUE
    REFERENCES privacy_data_disposition_admin_commands(command_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT privacy_disposition_command_provenance CHECK (
    (
      revision = 1
      AND disposition = 'REVIEW_REQUIRED'
      AND state = 'BLOCKED'
      AND disposition_admin_command_id IS NULL
    ) OR (
      revision > 1
      AND disposition <> 'REVIEW_REQUIRED'
      AND disposition_admin_command_id IS NOT NULL
    )
  );

CREATE FUNCTION initialize_erasure_data_dispositions()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE category privacy_retention_category;
BEGIN
  IF NEW.state <> 'ACTION_REQUIRED' OR NOT EXISTS (
    SELECT 1 FROM privacy_request_cases request
    WHERE request.case_id = NEW.case_id
      AND request.request_type = 'ERASURE'
  ) THEN
    RETURN NULL;
  END IF;

  FOR category IN SELECT unnest(enum_range(NULL::privacy_retention_category))
  LOOP
    INSERT INTO privacy_data_disposition_events (
      case_id, category, revision, disposition, state,
      actor_user_id, action_code, occurred_at
    ) VALUES (
      NEW.case_id, category, 1, 'REVIEW_REQUIRED', 'BLOCKED',
      NEW.actor_user_id, 'LEGAL_POLICY_REVIEW_REQUIRED', NEW.occurred_at
    ) ON CONFLICT (case_id, category, revision) DO NOTHING;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER privacy_erasure_dispositions_initialize
AFTER INSERT ON privacy_request_events
FOR EACH ROW EXECUTE FUNCTION initialize_erasure_data_dispositions();

CREATE FUNCTION apply_privacy_data_disposition_admin_command()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE request_state privacy_request_state;
DECLARE current_event privacy_data_disposition_events%ROWTYPE;
DECLARE policy privacy_retention_policy_versions%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  IF NOT privacy_admin_session_is_recent(
      NEW.actor_privileged_session_hash, NEW.actor_user_id
    ) THEN
    RAISE EXCEPTION 'recent MFA-backed privacy capability required';
  END IF;

  PERFORM 1 FROM privacy_request_cases
  WHERE case_id = NEW.case_id
  FOR SHARE;
  SELECT current_request.state INTO request_state
  FROM current_privacy_request_cases current_request
  WHERE current_request.case_id = NEW.case_id;
  IF request_state IS DISTINCT FROM 'ACTION_REQUIRED' THEN
    RAISE EXCEPTION 'privacy request must require category action';
  END IF;

  SELECT * INTO current_event
  FROM privacy_data_disposition_events
  WHERE case_id = NEW.case_id AND category = NEW.category
  ORDER BY revision DESC LIMIT 1
  FOR UPDATE;
  IF current_event.event_id IS NULL THEN
    RAISE EXCEPTION 'privacy category scope must be initialized';
  END IF;
  IF current_event.revision IS DISTINCT FROM NEW.expected_revision
    OR current_event.disposition IS DISTINCT FROM NEW.expected_disposition
    OR current_event.state IS DISTINCT FROM NEW.expected_state THEN
    RAISE EXCEPTION 'stale privacy disposition state';
  END IF;
  IF current_event.state NOT IN ('BLOCKED', 'READY', 'FAILED') THEN
    RAISE EXCEPTION 'privacy disposition is not reviewable';
  END IF;
  IF current_event.disposition = 'REVIEW_REQUIRED'
    AND current_event.state <> 'BLOCKED' THEN
    RAISE EXCEPTION 'invalid unresolved privacy disposition';
  END IF;
  IF current_event.disposition <> 'REVIEW_REQUIRED'
    AND current_event.state NOT IN ('READY', 'FAILED') THEN
    RAISE EXCEPTION 'resolved privacy disposition is not reviewable';
  END IF;

  SELECT * INTO policy
  FROM privacy_retention_policy_versions
  WHERE policy_version_id = NEW.policy_version_id
    AND category = NEW.category
    AND legal_review_state = 'APPROVED'
    AND launch_state = 'READY'
    AND duration_days IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'executable reviewed retention policy required';
  END IF;

  NEW.resulting_revision := NEW.expected_revision + 1;
  NEW.resulting_state := CASE
    WHEN NEW.resulting_disposition IN ('DELETE', 'ANONYMIZE')
      THEN 'READY'::privacy_disposition_state
    ELSE 'COMPLETED'::privacy_disposition_state
  END;

  INSERT INTO privacy_data_disposition_events (
    event_id, case_id, category, revision, disposition, state,
    policy_version_id, actor_user_id, action_code,
    disposition_admin_command_id, occurred_at
  ) VALUES (
    NEW.command_id, NEW.case_id, NEW.category, NEW.resulting_revision,
    NEW.resulting_disposition, NEW.resulting_state, NEW.policy_version_id,
    NEW.actor_user_id, NEW.action_code, NEW.command_id, NEW.occurred_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_data_disposition_admin_command_apply
BEFORE INSERT ON privacy_data_disposition_admin_commands
FOR EACH ROW EXECUTE FUNCTION apply_privacy_data_disposition_admin_command();

CREATE FUNCTION require_privacy_data_disposition_admin_audit()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.event_id = NEW.audit_event_id
      AND audit.correlation_id = NEW.command_id
      AND audit.category = 'PRIVILEGED_COMMAND'
      AND audit.actor_kind = 'AUTHENTICATED_USER'
      AND audit.actor_user_id = NEW.actor_user_id
      AND audit.actor_capability = 'admin.privacy.manage'
      AND audit.action_type = 'admin.privacy.disposition_decided'
      AND audit.target_type = 'PRIVACY_REQUEST'
      AND audit.target_id = NEW.case_id::text
      AND audit.reason = NEW.reason
  ) THEN
    RAISE EXCEPTION 'matching immutable privacy disposition audit required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER privacy_data_disposition_admin_audit_required
AFTER INSERT ON privacy_data_disposition_admin_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_privacy_data_disposition_admin_audit();

CREATE TRIGGER privacy_data_disposition_admin_commands_immutable
BEFORE UPDATE OR DELETE ON privacy_data_disposition_admin_commands
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

COMMENT ON TABLE privacy_data_disposition_admin_commands IS
  'Recent-MFA category decisions for erasure/account closure. DELETE and ANONYMIZE become retryable READY work; RETAIN and NO_DATA complete immediately. Every decision requires an approved READY policy with a concrete reviewed duration.';
