-- R4-022 / D22-D23: named, append-only administrative case actions.
-- This is operational case management, never a legal verdict, commercial
-- agreement mutation, payment instruction, reputation penalty or Job state.
CREATE TYPE dispute_admin_command_action AS ENUM (
  'START_REVIEW',
  'REQUEST_INFORMATION',
  'ADD_INTERNAL_NOTE',
  'RECORD_OUTCOME',
  'CLOSE',
  'REOPEN'
);
CREATE TYPE dispute_request_recipient AS ENUM (
  'CUSTOMER', 'PRIMARY_PROVIDER', 'BOTH'
);
CREATE TYPE dispute_outcome_category AS ENUM (
  'RESOLVED_BY_PARTIES',
  'OPERATIONAL_ADMIN_RESOLUTION',
  'NO_ACTION',
  'REFERRED_OUTSIDE_PLATFORM',
  'ACCOUNT_POLICY_ACTION',
  'OTHER'
);
CREATE TYPE dispute_outcome_basis AS ENUM (
  'MUTUAL_PARTY_AGREEMENT', 'ADMINISTRATIVE_CLOSURE'
);

ALTER TABLE dispute_case_state_events
  ALTER COLUMN actor_role DROP NOT NULL,
  ADD COLUMN admin_command_id uuid;

CREATE TABLE dispute_case_admin_commands (
  command_id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  action dispute_admin_command_action NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL,
  expected_state dispute_case_state NOT NULL,
  resulting_state dispute_case_state,
  reason text NOT NULL CHECK (
    audit_reason_is_safe(reason) AND reason !~ '[[:cntrl:]]'
  ),
  request_recipient dispute_request_recipient,
  request_text text,
  reply_deadline timestamptz,
  internal_note text,
  outcome_category dispute_outcome_category,
  outcome_basis dispute_outcome_basis,
  outcome_summary text,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  audit_event_id uuid NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dispute_admin_command_shape CHECK (
    (action = 'START_REVIEW'
      AND request_recipient IS NULL AND request_text IS NULL
      AND reply_deadline IS NULL AND internal_note IS NULL
      AND outcome_category IS NULL AND outcome_basis IS NULL
      AND outcome_summary IS NULL)
    OR (action = 'REQUEST_INFORMATION'
      AND request_recipient IS NOT NULL AND request_text IS NOT NULL
      AND internal_note IS NULL AND outcome_category IS NULL
      AND outcome_basis IS NULL AND outcome_summary IS NULL)
    OR (action = 'ADD_INTERNAL_NOTE'
      AND request_recipient IS NULL AND request_text IS NULL
      AND reply_deadline IS NULL AND internal_note IS NOT NULL
      AND outcome_category IS NULL AND outcome_basis IS NULL
      AND outcome_summary IS NULL)
    OR (action = 'RECORD_OUTCOME'
      AND request_recipient IS NULL AND request_text IS NULL
      AND reply_deadline IS NULL AND internal_note IS NULL
      AND outcome_category IS NOT NULL AND outcome_basis IS NOT NULL
      AND outcome_summary IS NOT NULL)
    OR (action IN ('CLOSE', 'REOPEN')
      AND request_recipient IS NULL AND request_text IS NULL
      AND reply_deadline IS NULL AND internal_note IS NULL
      AND outcome_category IS NULL AND outcome_basis IS NULL
      AND outcome_summary IS NULL)
  ),
  CONSTRAINT dispute_admin_request_text_bounded CHECK (
    request_text IS NULL OR (
      request_text = btrim(request_text)
      AND length(request_text) BETWEEN 1 AND 2000
      AND request_text !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT dispute_admin_note_bounded CHECK (
    internal_note IS NULL OR (
      internal_note = btrim(internal_note)
      AND length(internal_note) BETWEEN 1 AND 4000
      AND internal_note !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT dispute_admin_outcome_bounded CHECK (
    outcome_summary IS NULL OR (
      outcome_summary = btrim(outcome_summary)
      AND length(outcome_summary) BETWEEN 1 AND 4000
      AND outcome_summary !~ '[[:cntrl:]]'
    )
  )
);
CREATE INDEX dispute_admin_commands_case_idx
  ON dispute_case_admin_commands (dispute_id, recorded_at, command_id);

ALTER TABLE dispute_case_state_events
  ADD CONSTRAINT dispute_state_event_admin_command_fk
  FOREIGN KEY (admin_command_id)
  REFERENCES dispute_case_admin_commands(command_id) ON DELETE RESTRICT,
  ADD CONSTRAINT dispute_state_event_actor_shape CHECK (
    (action = 'OPEN' AND actor_role IS NOT NULL AND admin_command_id IS NULL)
    OR (action <> 'OPEN' AND actor_role IS NULL AND admin_command_id IS NOT NULL)
  );

CREATE TABLE dispute_case_information_requests (
  id uuid PRIMARY KEY REFERENCES dispute_case_admin_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  recipient dispute_request_recipient NOT NULL,
  request_text text NOT NULL,
  reply_deadline timestamptz,
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL
);
CREATE INDEX dispute_information_requests_case_idx
  ON dispute_case_information_requests (dispute_id, requested_at, id);

CREATE TABLE dispute_case_internal_notes (
  id uuid PRIMARY KEY REFERENCES dispute_case_admin_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  body text NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL
);
CREATE INDEX dispute_internal_notes_case_idx
  ON dispute_case_internal_notes (dispute_id, created_at, id);

CREATE TABLE dispute_case_outcomes (
  id uuid PRIMARY KEY REFERENCES dispute_case_admin_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  category dispute_outcome_category NOT NULL,
  basis dispute_outcome_basis NOT NULL,
  summary text NOT NULL,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX dispute_outcomes_case_idx
  ON dispute_case_outcomes (dispute_id, recorded_at, id);

CREATE VIEW current_dispute_case_outcomes
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (outcome.dispute_id)
  outcome.id, outcome.dispute_id, outcome.category, outcome.basis,
  outcome.summary, outcome.recorded_by_user_id, outcome.recorded_at
FROM dispute_case_outcomes outcome
ORDER BY outcome.dispute_id, outcome.recorded_at DESC, outcome.id DESC;

CREATE FUNCTION admin_dispute_session_is_recent(
  session_hash char(64), actor_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_privileged_sessions privileged
    JOIN auth_sessions base ON base.session_id_hash = privileged.session_id_hash
      AND base.user_id = privileged.user_id AND base.revoked_at IS NULL
      AND base.expires_at > clock_timestamp()
    JOIN users actor ON actor.id = privileged.user_id
      AND actor.account_state = 'ACTIVE'
    JOIN admin_mfa_factors factor ON factor.id = privileged.mfa_factor_id
      AND factor.user_id = privileged.user_id AND factor.revoked_at IS NULL
    JOIN admin_role_grants role ON role.user_id = privileged.user_id
      AND role.revoked_at IS NULL AND role.role IN ('ADMIN', 'SUPER_ADMIN')
    WHERE privileged.session_id_hash = session_hash
      AND privileged.user_id = actor_id AND privileged.revoked_at IS NULL
      AND privileged.expires_at > clock_timestamp()
      AND privileged.mfa_authenticated_at >= clock_timestamp() - interval '15 minutes'
  )
$$;

CREATE FUNCTION validate_dispute_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state dispute_case_state;
DECLARE party_actor boolean;
BEGIN
  PERFORM 1 FROM dispute_cases
  WHERE id = NEW.dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute case required'; END IF;
  SELECT current.state INTO current_state
  FROM current_dispute_cases current
  WHERE current.id = NEW.dispute_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute state required'; END IF;
  IF current_state IS DISTINCT FROM NEW.expected_state THEN
    RAISE EXCEPTION 'stale dispute state';
  END IF;
  SELECT dispute_actor_role(dispute.job_id, NEW.actor_user_id) IS NOT NULL
    INTO party_actor FROM dispute_cases dispute
    WHERE dispute.id = NEW.dispute_id;
  IF party_actor OR NOT admin_dispute_session_is_recent(
      NEW.actor_privileged_session_hash, NEW.actor_user_id) THEN
    RAISE EXCEPTION 'recent MFA-backed dispute capability required';
  END IF;

  NEW.resulting_state := CASE NEW.action
    WHEN 'START_REVIEW' THEN 'UNDER_REVIEW'::dispute_case_state
    WHEN 'REQUEST_INFORMATION' THEN 'WAITING_FOR_PARTY'::dispute_case_state
    WHEN 'RECORD_OUTCOME' THEN 'RESOLVED'::dispute_case_state
    WHEN 'CLOSE' THEN 'CLOSED'::dispute_case_state
    WHEN 'REOPEN' THEN 'UNDER_REVIEW'::dispute_case_state
    ELSE NULL
  END;
  IF (NEW.action = 'START_REVIEW' AND current_state NOT IN ('OPEN', 'WAITING_FOR_PARTY'))
      OR (NEW.action = 'REQUEST_INFORMATION'
        AND current_state NOT IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW'))
      OR (NEW.action = 'RECORD_OUTCOME'
        AND current_state NOT IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW'))
      OR (NEW.action = 'CLOSE' AND current_state <> 'RESOLVED')
      OR (NEW.action = 'REOPEN' AND current_state <> 'CLOSED')
      OR (NEW.action = 'ADD_INTERNAL_NOTE' AND NEW.resulting_state IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid dispute admin transition';
  END IF;
  IF NEW.action = 'REQUEST_INFORMATION'
      AND NEW.reply_deadline IS NOT NULL
      AND NEW.reply_deadline <= clock_timestamp() THEN
    RAISE EXCEPTION 'future operational reply deadline required';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_admin_command_validate
BEFORE INSERT ON dispute_case_admin_commands
FOR EACH ROW EXECUTE FUNCTION validate_dispute_admin_command();

CREATE OR REPLACE FUNCTION validate_dispute_case_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dispute dispute_cases%ROWTYPE;
DECLARE current_state dispute_case_state;
DECLARE next_sequence integer;
DECLARE command dispute_case_admin_commands%ROWTYPE;
BEGIN
  SELECT * INTO dispute FROM dispute_cases
  WHERE id = NEW.dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute case required'; END IF;
  IF NEW.action = 'OPEN' THEN
    IF pg_trigger_depth() < 2
        OR NEW.event_id IS DISTINCT FROM dispute.id
        OR NEW.event_sequence <> 1
        OR NEW.from_state IS NOT NULL OR NEW.to_state <> 'OPEN'
        OR NEW.actor_user_id IS DISTINCT FROM dispute.opened_by_user_id
        OR NEW.actor_role IS DISTINCT FROM dispute.opened_by_role
        OR NEW.admin_command_id IS NOT NULL OR NEW.reason IS NOT NULL
        OR NEW.occurred_at IS DISTINCT FROM dispute.created_at THEN
      RAISE EXCEPTION 'initial dispute state must derive from case creation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO command FROM dispute_case_admin_commands
  WHERE command_id = NEW.admin_command_id;
  SELECT event.to_state, event.event_sequence + 1
    INTO current_state, next_sequence
  FROM dispute_case_state_events event
  WHERE event.dispute_id = NEW.dispute_id
  ORDER BY event.event_sequence DESC LIMIT 1;
  IF pg_trigger_depth() < 2 OR NOT FOUND
      OR command.command_id IS NULL
      OR command.dispute_id IS DISTINCT FROM NEW.dispute_id
      OR command.action::text IS DISTINCT FROM NEW.action::text
      OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id
      OR command.expected_state IS DISTINCT FROM current_state
      OR command.resulting_state IS DISTINCT FROM NEW.to_state
      OR NEW.event_id IS DISTINCT FROM command.command_id
      OR NEW.event_sequence IS DISTINCT FROM next_sequence
      OR NEW.from_state IS DISTINCT FROM current_state
      OR NEW.actor_role IS NOT NULL OR NEW.reason IS NOT NULL
      OR NEW.occurred_at IS DISTINCT FROM command.recorded_at THEN
    RAISE EXCEPTION 'admin dispute state must derive from audited command';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION apply_dispute_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_sequence integer;
DECLARE recipient_id uuid;
BEGIN
  IF NEW.action = 'ADD_INTERNAL_NOTE' THEN
    INSERT INTO dispute_case_internal_notes (
      id, dispute_id, body, author_user_id, created_at
    ) VALUES (
      NEW.command_id, NEW.dispute_id, NEW.internal_note,
      NEW.actor_user_id, NEW.recorded_at
    );
  ELSIF NEW.action = 'REQUEST_INFORMATION' THEN
    INSERT INTO dispute_case_information_requests (
      id, dispute_id, recipient, request_text, reply_deadline,
      requested_by_user_id, requested_at
    ) VALUES (
      NEW.command_id, NEW.dispute_id, NEW.request_recipient,
      NEW.request_text, NEW.reply_deadline, NEW.actor_user_id, NEW.recorded_at
    );
  ELSIF NEW.action = 'RECORD_OUTCOME' THEN
    INSERT INTO dispute_case_outcomes (
      id, dispute_id, category, basis, summary,
      recorded_by_user_id, recorded_at
    ) VALUES (
      NEW.command_id, NEW.dispute_id, NEW.outcome_category,
      NEW.outcome_basis, NEW.outcome_summary, NEW.actor_user_id, NEW.recorded_at
    );
  END IF;

  IF NEW.resulting_state IS NOT NULL THEN
    SELECT coalesce(max(event_sequence), 0) + 1 INTO next_sequence
    FROM dispute_case_state_events WHERE dispute_id = NEW.dispute_id;
    INSERT INTO dispute_case_state_events (
      event_id, dispute_id, event_sequence, action, from_state, to_state,
      actor_user_id, actor_role, reason, occurred_at, admin_command_id
    ) VALUES (
      NEW.command_id, NEW.dispute_id, next_sequence, NEW.action::text::dispute_case_transition_action,
      NEW.expected_state, NEW.resulting_state, NEW.actor_user_id, NULL, NULL,
      NEW.recorded_at, NEW.command_id
    );
  END IF;

  IF NEW.action <> 'ADD_INTERNAL_NOTE' THEN
    FOR recipient_id IN
      SELECT customer.owner_user_id FROM dispute_cases dispute
      JOIN jobs job ON job.id = dispute.job_id
      JOIN customer_profiles customer ON customer.id = job.customer_profile_id
      WHERE dispute.id = NEW.dispute_id
      UNION
      SELECT provider.owner_user_id FROM dispute_cases dispute
      JOIN jobs job ON job.id = dispute.job_id
      JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
      WHERE dispute.id = NEW.dispute_id
    LOOP
      IF NEW.action <> 'REQUEST_INFORMATION'
          OR NEW.request_recipient = 'BOTH'
          OR NEW.request_recipient::text = dispute_actor_role(
            (SELECT job_id FROM dispute_cases WHERE id = NEW.dispute_id), recipient_id
          )::text THEN
        PERFORM insert_exact_notification_outbox_event(
          'dispute:' || NEW.dispute_id::text || ':admin:' || NEW.command_id::text || ':' || recipient_id::text,
          'job.dispute.admin_action', NEW.recorded_at,
          'DISPUTE_CASE', NEW.dispute_id::text,
          jsonb_build_object(
            'recipient_user_id', recipient_id::text,
            'job_id', (SELECT job_id::text FROM dispute_cases
              WHERE id = NEW.dispute_id),
            'dispute_id', NEW.dispute_id::text,
            'action', NEW.action::text
          ),
          'job.dispute.admin_action', NEW.command_id::text, NEW.recorded_at
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER dispute_admin_command_apply
AFTER INSERT ON dispute_case_admin_commands
FOR EACH ROW EXECUTE FUNCTION apply_dispute_admin_command();

CREATE FUNCTION require_dispute_admin_command_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_action text;
BEGIN
  expected_action := CASE NEW.action
    WHEN 'START_REVIEW' THEN 'admin.dispute.review_started'
    WHEN 'REQUEST_INFORMATION' THEN 'admin.dispute.information_requested'
    WHEN 'ADD_INTERNAL_NOTE' THEN 'admin.dispute.internal_note_added'
    WHEN 'RECORD_OUTCOME' THEN 'admin.dispute.outcome_recorded'
    WHEN 'CLOSE' THEN 'admin.dispute.closed'
    WHEN 'REOPEN' THEN 'admin.dispute.reopened'
  END;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.event_id = NEW.audit_event_id
      AND audit.correlation_id = NEW.command_id
      AND audit.category = 'PRIVILEGED_COMMAND'
      AND audit.action_type = expected_action
      AND audit.actor_kind = 'AUTHENTICATED_USER'
      AND audit.actor_user_id = NEW.actor_user_id
      AND audit.actor_capability = 'admin.disputes.manage'
      AND audit.target_type = 'DISPUTE_CASE'
      AND audit.target_id = NEW.dispute_id::text
      AND audit.reason = NEW.reason
  ) THEN
    RAISE EXCEPTION 'matching immutable dispute command audit event required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dispute_admin_command_audit_required
AFTER INSERT ON dispute_case_admin_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_dispute_admin_command_audit();

CREATE TRIGGER dispute_admin_command_immutable
BEFORE UPDATE OR DELETE ON dispute_case_admin_commands
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_information_request_immutable
BEFORE UPDATE OR DELETE ON dispute_case_information_requests
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_internal_note_immutable
BEFORE UPDATE OR DELETE ON dispute_case_internal_notes
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_outcome_immutable
BEFORE UPDATE OR DELETE ON dispute_case_outcomes
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();

COMMENT ON TABLE dispute_case_admin_commands IS
  'Named recent-MFA case operations with mandatory immutable audit; no generic state setter.';
COMMENT ON TABLE dispute_case_internal_notes IS
  'Private append-only administrator notes, never projected to a case party.';
COMMENT ON TABLE dispute_case_information_requests IS
  'User-facing operational requests; a missed deadline is only a process fact.';
COMMENT ON TABLE dispute_case_outcomes IS
  'Operational marketplace outcome and summary; never a legal verdict or commercial rewrite.';
