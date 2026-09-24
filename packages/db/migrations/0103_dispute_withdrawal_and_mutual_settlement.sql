-- R4-022 / D22: opener withdrawal is blocked by an explicit serious-signal
-- hold, while a self-settlement resolves only after both contractual roles
-- have independently confirmed the same concise summary.
CREATE TYPE dispute_party_command_action AS ENUM (
  'WITHDRAW', 'CONFIRM_SETTLEMENT'
);

CREATE TABLE dispute_case_investigation_hold_events (
  id uuid PRIMARY KEY REFERENCES dispute_case_admin_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX dispute_investigation_hold_case_idx
  ON dispute_case_investigation_hold_events (dispute_id, recorded_at, id);

CREATE VIEW current_dispute_case_investigation_holds
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (event.dispute_id)
  event.id, event.dispute_id, event.is_active, event.actor_user_id,
  event.recorded_at
FROM dispute_case_investigation_hold_events event
ORDER BY event.dispute_id, event.recorded_at DESC, event.id DESC;

ALTER TABLE dispute_case_admin_commands
  DROP CONSTRAINT dispute_admin_command_shape,
  ADD CONSTRAINT dispute_admin_command_shape CHECK (
    (action IN (
        'START_REVIEW', 'SET_INVESTIGATION_HOLD',
        'CLEAR_INVESTIGATION_HOLD'
      )
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
  );

CREATE OR REPLACE FUNCTION validate_dispute_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state dispute_case_state;
DECLARE party_actor boolean;
DECLARE investigation_held boolean;
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
  SELECT coalesce((
    SELECT hold.is_active FROM current_dispute_case_investigation_holds hold
    WHERE hold.dispute_id = NEW.dispute_id
  ), false) INTO investigation_held;

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
      OR (NEW.action = 'SET_INVESTIGATION_HOLD'
        AND (current_state NOT IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW')
          OR investigation_held))
      OR (NEW.action = 'CLEAR_INVESTIGATION_HOLD'
        AND (current_state NOT IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW')
          OR NOT investigation_held))
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

CREATE OR REPLACE FUNCTION apply_dispute_admin_command()
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
  ELSIF NEW.action IN ('SET_INVESTIGATION_HOLD', 'CLEAR_INVESTIGATION_HOLD') THEN
    INSERT INTO dispute_case_investigation_hold_events (
      id, dispute_id, is_active, actor_user_id, recorded_at
    ) VALUES (
      NEW.command_id, NEW.dispute_id,
      NEW.action = 'SET_INVESTIGATION_HOLD', NEW.actor_user_id, NEW.recorded_at
    );
  END IF;

  IF NEW.resulting_state IS NOT NULL THEN
    SELECT coalesce(max(event_sequence), 0) + 1 INTO next_sequence
    FROM dispute_case_state_events WHERE dispute_id = NEW.dispute_id;
    INSERT INTO dispute_case_state_events (
      event_id, dispute_id, event_sequence, action, from_state, to_state,
      actor_user_id, actor_role, reason, occurred_at, admin_command_id
    ) VALUES (
      NEW.command_id, NEW.dispute_id, next_sequence,
      NEW.action::text::dispute_case_transition_action,
      NEW.expected_state, NEW.resulting_state, NEW.actor_user_id, NULL, NULL,
      NEW.recorded_at, NEW.command_id
    );
  END IF;

  IF NEW.action IN (
      'START_REVIEW', 'REQUEST_INFORMATION', 'RECORD_OUTCOME', 'CLOSE', 'REOPEN'
    ) THEN
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

CREATE OR REPLACE FUNCTION require_dispute_admin_command_audit()
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
    WHEN 'SET_INVESTIGATION_HOLD' THEN 'admin.dispute.investigation_hold_set'
    WHEN 'CLEAR_INVESTIGATION_HOLD' THEN 'admin.dispute.investigation_hold_cleared'
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

CREATE TABLE dispute_case_party_commands (
  command_id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  action dispute_party_command_action NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_role dispute_party_role NOT NULL,
  expected_state dispute_case_state NOT NULL CHECK (
    expected_state IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW')
  ),
  settlement_summary text,
  withdrawal_reason text,
  command_intent_sha256 char(64) NOT NULL CHECK (
    command_intent_sha256 ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dispute_party_command_shape CHECK (
    (action = 'WITHDRAW' AND settlement_summary IS NULL)
    OR (action = 'CONFIRM_SETTLEMENT'
      AND settlement_summary IS NOT NULL AND withdrawal_reason IS NULL)
  ),
  CONSTRAINT dispute_settlement_summary_bounded CHECK (
    settlement_summary IS NULL OR (
      settlement_summary = btrim(settlement_summary)
      AND length(settlement_summary) BETWEEN 8 AND 2000
      AND settlement_summary !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT dispute_withdrawal_reason_bounded CHECK (
    withdrawal_reason IS NULL OR (
      withdrawal_reason = btrim(withdrawal_reason)
      AND length(withdrawal_reason) BETWEEN 1 AND 1000
      AND withdrawal_reason !~ '[[:cntrl:]]'
    )
  )
);
CREATE INDEX dispute_party_commands_case_idx
  ON dispute_case_party_commands (dispute_id, recorded_at, command_id);

CREATE TABLE dispute_case_withdrawals (
  id uuid PRIMARY KEY REFERENCES dispute_case_party_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL UNIQUE REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  withdrawn_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  withdrawn_by_role dispute_party_role NOT NULL,
  reason text,
  withdrawn_at timestamptz NOT NULL
);

CREATE TABLE dispute_case_settlement_confirmations (
  id uuid PRIMARY KEY REFERENCES dispute_case_party_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  confirmed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_by_role dispute_party_role NOT NULL,
  summary text NOT NULL,
  confirmed_at timestamptz NOT NULL
);
CREATE INDEX dispute_settlement_confirmation_case_idx
  ON dispute_case_settlement_confirmations (
    dispute_id, confirmed_by_role, confirmed_at DESC, id DESC
  );

CREATE VIEW current_dispute_settlement_confirmations
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (confirmation.dispute_id, confirmation.confirmed_by_role)
  confirmation.id, confirmation.dispute_id, confirmation.confirmed_by_user_id,
  confirmation.confirmed_by_role, confirmation.summary,
  confirmation.confirmed_at
FROM dispute_case_settlement_confirmations confirmation
ORDER BY confirmation.dispute_id, confirmation.confirmed_by_role,
  confirmation.confirmed_at DESC, confirmation.id DESC;

CREATE TABLE dispute_case_party_settlement_outcomes (
  id uuid PRIMARY KEY REFERENCES dispute_case_party_commands(command_id)
    ON DELETE RESTRICT,
  dispute_id uuid NOT NULL UNIQUE REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  summary text NOT NULL,
  completed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL
);

CREATE OR REPLACE VIEW current_dispute_case_outcomes
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (outcome.dispute_id)
  outcome.id, outcome.dispute_id, outcome.category, outcome.basis,
  outcome.summary, outcome.recorded_by_user_id, outcome.recorded_at
FROM (
  SELECT admin.id, admin.dispute_id, admin.category, admin.basis,
    admin.summary, admin.recorded_by_user_id, admin.recorded_at
  FROM dispute_case_outcomes admin
  UNION ALL
  SELECT party.id, party.dispute_id,
    'RESOLVED_BY_PARTIES'::dispute_outcome_category,
    'MUTUAL_PARTY_AGREEMENT'::dispute_outcome_basis,
    party.summary, party.completed_by_user_id, party.recorded_at
  FROM dispute_case_party_settlement_outcomes party
) outcome
ORDER BY outcome.dispute_id, outcome.recorded_at DESC, outcome.id DESC;

ALTER TABLE dispute_case_state_events
  ADD COLUMN party_command_id uuid,
  ADD CONSTRAINT dispute_state_event_party_command_fk
    FOREIGN KEY (party_command_id)
    REFERENCES dispute_case_party_commands(command_id) ON DELETE RESTRICT,
  DROP CONSTRAINT dispute_state_event_actor_shape,
  ADD CONSTRAINT dispute_state_event_actor_shape CHECK (
    (action = 'OPEN' AND actor_role IS NOT NULL
      AND admin_command_id IS NULL AND party_command_id IS NULL)
    OR (action NOT IN ('OPEN', 'WITHDRAW', 'CONFIRM_SETTLEMENT')
      AND actor_role IS NULL
      AND admin_command_id IS NOT NULL AND party_command_id IS NULL)
    OR (action IN ('WITHDRAW', 'CONFIRM_SETTLEMENT')
      AND actor_role IS NOT NULL
      AND admin_command_id IS NULL AND party_command_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION validate_dispute_case_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dispute dispute_cases%ROWTYPE;
DECLARE current_state dispute_case_state;
DECLARE next_sequence integer;
DECLARE admin_command dispute_case_admin_commands%ROWTYPE;
DECLARE party_command dispute_case_party_commands%ROWTYPE;
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
        OR NEW.admin_command_id IS NOT NULL OR NEW.party_command_id IS NOT NULL
        OR NEW.reason IS NOT NULL
        OR NEW.occurred_at IS DISTINCT FROM dispute.created_at THEN
      RAISE EXCEPTION 'initial dispute state must derive from case creation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT event.to_state, event.event_sequence + 1
    INTO current_state, next_sequence
  FROM dispute_case_state_events event
  WHERE event.dispute_id = NEW.dispute_id
  ORDER BY event.event_sequence DESC LIMIT 1;
  IF pg_trigger_depth() < 2 OR NOT FOUND
      OR NEW.event_sequence IS DISTINCT FROM next_sequence
      OR NEW.from_state IS DISTINCT FROM current_state
      OR NEW.reason IS NOT NULL THEN
    RAISE EXCEPTION 'derived dispute transition required';
  END IF;

  IF NEW.admin_command_id IS NOT NULL THEN
    SELECT * INTO admin_command FROM dispute_case_admin_commands
    WHERE command_id = NEW.admin_command_id;
    IF admin_command.command_id IS NULL
        OR admin_command.dispute_id IS DISTINCT FROM NEW.dispute_id
        OR admin_command.action::text IS DISTINCT FROM NEW.action::text
        OR admin_command.actor_user_id IS DISTINCT FROM NEW.actor_user_id
        OR admin_command.expected_state IS DISTINCT FROM current_state
        OR admin_command.resulting_state IS DISTINCT FROM NEW.to_state
        OR NEW.event_id IS DISTINCT FROM admin_command.command_id
        OR NEW.actor_role IS NOT NULL
        OR NEW.party_command_id IS NOT NULL
        OR NEW.occurred_at IS DISTINCT FROM admin_command.recorded_at THEN
      RAISE EXCEPTION 'admin dispute state must derive from audited command';
    END IF;
  ELSIF NEW.party_command_id IS NOT NULL THEN
    SELECT * INTO party_command FROM dispute_case_party_commands
    WHERE command_id = NEW.party_command_id;
    IF party_command.command_id IS NULL
        OR party_command.dispute_id IS DISTINCT FROM NEW.dispute_id
        OR party_command.action::text IS DISTINCT FROM NEW.action::text
        OR party_command.actor_user_id IS DISTINCT FROM NEW.actor_user_id
        OR party_command.actor_role IS DISTINCT FROM NEW.actor_role
        OR party_command.expected_state IS DISTINCT FROM current_state
        OR NEW.event_id IS DISTINCT FROM party_command.command_id
        OR NEW.admin_command_id IS NOT NULL
        OR NEW.occurred_at IS DISTINCT FROM party_command.recorded_at
        OR (party_command.action = 'WITHDRAW' AND NEW.to_state <> 'CLOSED')
        OR (party_command.action = 'CONFIRM_SETTLEMENT'
          AND NEW.to_state <> 'RESOLVED') THEN
      RAISE EXCEPTION 'party dispute state must derive from exact command';
    END IF;
  ELSE
    RAISE EXCEPTION 'dispute transition command required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_dispute_party_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_state dispute_case_state;
DECLARE actual_role dispute_party_role;
DECLARE opener_user_id uuid;
DECLARE held boolean;
BEGIN
  SELECT current.state, identity.opened_by_user_id
    INTO actual_state, opener_user_id
  FROM dispute_cases identity
  JOIN current_dispute_cases current ON current.id = identity.id
  WHERE identity.id = NEW.dispute_id FOR UPDATE OF identity;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute case required'; END IF;
  actual_role := dispute_actor_role(
    (SELECT job_id FROM dispute_cases WHERE id = NEW.dispute_id),
    NEW.actor_user_id
  );
  IF actual_role IS NULL OR actual_role IS DISTINCT FROM NEW.actor_role THEN
    RAISE EXCEPTION 'exact active contractual dispute party required';
  END IF;
  IF actual_state IS DISTINCT FROM NEW.expected_state
      OR actual_state NOT IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'active exact dispute state required';
  END IF;
  IF NEW.action = 'WITHDRAW' THEN
    SELECT coalesce((SELECT hold.is_active
      FROM current_dispute_case_investigation_holds hold
      WHERE hold.dispute_id = NEW.dispute_id), false) INTO held;
    IF NEW.actor_user_id IS DISTINCT FROM opener_user_id OR held THEN
      RAISE EXCEPTION 'withdrawal unavailable while investigation is retained';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_party_command_validate
BEFORE INSERT ON dispute_case_party_commands
FOR EACH ROW EXECUTE FUNCTION validate_dispute_party_command();

CREATE FUNCTION apply_dispute_party_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_sequence integer;
DECLARE other_summary text;
DECLARE recipient_id uuid;
BEGIN
  IF NEW.action = 'WITHDRAW' THEN
    INSERT INTO dispute_case_withdrawals (
      id, dispute_id, withdrawn_by_user_id, withdrawn_by_role,
      reason, withdrawn_at
    ) VALUES (
      NEW.command_id, NEW.dispute_id, NEW.actor_user_id, NEW.actor_role,
      NEW.withdrawal_reason, NEW.recorded_at
    );
    SELECT coalesce(max(event_sequence), 0) + 1 INTO next_sequence
    FROM dispute_case_state_events WHERE dispute_id = NEW.dispute_id;
    INSERT INTO dispute_case_state_events (
      event_id, dispute_id, event_sequence, action, from_state, to_state,
      actor_user_id, actor_role, reason, occurred_at, party_command_id
    ) VALUES (
      NEW.command_id, NEW.dispute_id, next_sequence, 'WITHDRAW',
      NEW.expected_state, 'CLOSED', NEW.actor_user_id, NEW.actor_role,
      NULL, NEW.recorded_at, NEW.command_id
    );
  ELSE
    INSERT INTO dispute_case_settlement_confirmations (
      id, dispute_id, confirmed_by_user_id, confirmed_by_role,
      summary, confirmed_at
    ) VALUES (
      NEW.command_id, NEW.dispute_id, NEW.actor_user_id, NEW.actor_role,
      NEW.settlement_summary, NEW.recorded_at
    );
    SELECT confirmation.summary INTO other_summary
    FROM current_dispute_settlement_confirmations confirmation
    WHERE confirmation.dispute_id = NEW.dispute_id
      AND confirmation.confirmed_by_role <> NEW.actor_role;
    IF other_summary IS NOT DISTINCT FROM NEW.settlement_summary THEN
      INSERT INTO dispute_case_party_settlement_outcomes (
        id, dispute_id, summary, completed_by_user_id, recorded_at
      ) VALUES (
        NEW.command_id, NEW.dispute_id, NEW.settlement_summary,
        NEW.actor_user_id, NEW.recorded_at
      );
      SELECT coalesce(max(event_sequence), 0) + 1 INTO next_sequence
      FROM dispute_case_state_events WHERE dispute_id = NEW.dispute_id;
      INSERT INTO dispute_case_state_events (
        event_id, dispute_id, event_sequence, action, from_state, to_state,
        actor_user_id, actor_role, reason, occurred_at, party_command_id
      ) VALUES (
        NEW.command_id, NEW.dispute_id, next_sequence, 'CONFIRM_SETTLEMENT',
        NEW.expected_state, 'RESOLVED', NEW.actor_user_id, NEW.actor_role,
        NULL, NEW.recorded_at, NEW.command_id
      );
    END IF;
  END IF;

  SELECT CASE NEW.actor_role
      WHEN 'CUSTOMER' THEN provider.owner_user_id
      ELSE customer.owner_user_id END
    INTO recipient_id
  FROM dispute_cases dispute
  JOIN jobs job ON job.id = dispute.job_id
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  WHERE dispute.id = NEW.dispute_id;
  PERFORM insert_exact_notification_outbox_event(
    'dispute:' || NEW.dispute_id::text || ':party:' || NEW.command_id::text || ':' || recipient_id::text,
    'job.dispute.party_action', NEW.recorded_at,
    'DISPUTE_CASE', NEW.dispute_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'job_id', (SELECT job_id::text FROM dispute_cases
        WHERE id = NEW.dispute_id),
      'dispute_id', NEW.dispute_id::text,
      'action', NEW.action::text
    ),
    'job.dispute.party_action', NEW.command_id::text, NEW.recorded_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER dispute_party_command_apply
AFTER INSERT ON dispute_case_party_commands
FOR EACH ROW EXECUTE FUNCTION apply_dispute_party_command();

CREATE TRIGGER dispute_party_command_immutable
BEFORE UPDATE OR DELETE ON dispute_case_party_commands
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_withdrawal_immutable
BEFORE UPDATE OR DELETE ON dispute_case_withdrawals
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_settlement_confirmation_immutable
BEFORE UPDATE OR DELETE ON dispute_case_settlement_confirmations
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_party_settlement_outcome_immutable
BEFORE UPDATE OR DELETE ON dispute_case_party_settlement_outcomes
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_investigation_hold_immutable
BEFORE UPDATE OR DELETE ON dispute_case_investigation_hold_events
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();

COMMENT ON TABLE dispute_case_party_commands IS
  'Append-only opener withdrawal and bilateral exact-summary settlement confirmations.';
COMMENT ON TABLE dispute_case_investigation_hold_events IS
  'Private audited serious-signal hold; blocks withdrawal without exposing the reason.';
COMMENT ON TABLE dispute_case_party_settlement_outcomes IS
  'Mutual operational settlement record; never rewrites the accepted agreement.';
