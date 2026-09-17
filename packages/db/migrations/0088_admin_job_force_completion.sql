-- D20/D23: an exceptional administrative completion is never a customer
-- acceptance. It has its own immutable provenance and mandatory audit event.
CREATE TABLE job_admin_completion_commands (
  command_id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL,
  expected_state job_state NOT NULL CHECK (expected_state IN
    ('IN_PROGRESS', 'COMPLETION_REQUESTED')),
  reason text NOT NULL CHECK (audit_reason_is_safe(reason)
    AND reason !~ '[[:cntrl:]]'),
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  audit_event_id uuid NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_job_admin_completion_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_state job_state; privileged_ok boolean;
  customer_owner uuid; provider_owner uuid;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job required'; END IF;
  SELECT state.state, customer.owner_user_id, provider.owner_user_id
    INTO actual_state, customer_owner, provider_owner
  FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  WHERE job.id = NEW.job_id;
  IF actual_state IS DISTINCT FROM NEW.expected_state
    OR actual_state NOT IN ('IN_PROGRESS', 'COMPLETION_REQUESTED') THEN
    RAISE EXCEPTION 'eligible exact Job state required';
  END IF;
  IF NEW.actor_user_id IN (customer_owner, provider_owner) THEN
    RAISE EXCEPTION 'Job party cannot administratively complete own Job';
  END IF;
  SELECT true INTO privileged_ok FROM admin_privileged_sessions privileged
  JOIN auth_sessions base ON base.session_id_hash = privileged.session_id_hash
    AND base.user_id = privileged.user_id AND base.revoked_at IS NULL
    AND base.expires_at > clock_timestamp()
  JOIN users actor ON actor.id = privileged.user_id
    AND actor.account_state = 'ACTIVE'
  JOIN admin_mfa_factors factor ON factor.id = privileged.mfa_factor_id
    AND factor.user_id = privileged.user_id AND factor.revoked_at IS NULL
  JOIN admin_role_grants role ON role.user_id = privileged.user_id
    AND role.revoked_at IS NULL AND role.role IN ('ADMIN', 'SUPER_ADMIN')
  WHERE privileged.session_id_hash = NEW.actor_privileged_session_hash
    AND privileged.user_id = NEW.actor_user_id AND privileged.revoked_at IS NULL
    AND privileged.expires_at > clock_timestamp()
    AND privileged.mfa_authenticated_at >= clock_timestamp() - interval '15 minutes'
  LIMIT 1 FOR UPDATE OF privileged, base, actor, factor, role;
  IF privileged_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'recent MFA-backed Job correction capability required';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_admin_completion_validate BEFORE INSERT ON job_admin_completion_commands
  FOR EACH ROW EXECUTE FUNCTION validate_job_admin_completion_command();
CREATE TRIGGER job_admin_completion_immutable BEFORE UPDATE OR DELETE
  ON job_admin_completion_commands FOR EACH ROW
  EXECUTE FUNCTION reject_job_completion_mutation();

CREATE FUNCTION require_job_admin_completion_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_events audit
    WHERE audit.event_id = NEW.audit_event_id
      AND audit.correlation_id = NEW.command_id
      AND audit.category = 'PRIVILEGED_COMMAND'
      AND audit.action_type = 'admin.job.force_completed'
      AND audit.actor_kind = 'AUTHENTICATED_USER'
      AND audit.actor_user_id = NEW.actor_user_id
      AND audit.actor_capability = 'admin.jobs.correct'
      AND audit.target_type = 'JOB' AND audit.target_id = NEW.job_id::text
      AND audit.reason = NEW.reason) THEN
    RAISE EXCEPTION 'matching immutable privileged Job audit event required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER job_admin_completion_audit_required
  AFTER INSERT ON job_admin_completion_commands DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_job_admin_completion_audit();

CREATE OR REPLACE VIEW current_job_states AS
SELECT job.id AS job_id,
  CASE
    WHEN cancelled.command_id IS NOT NULL THEN 'CANCELLED'::job_state
    WHEN admin_completion.command_id IS NOT NULL THEN 'COMPLETED'::job_state
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
LEFT JOIN job_admin_completion_commands admin_completion
  ON admin_completion.job_id = job.id
LEFT JOIN LATERAL (
  SELECT id FROM job_completion_attempts attempt
  WHERE attempt.job_id = job.id ORDER BY attempt_number DESC LIMIT 1
) latest ON true
LEFT JOIN job_completion_decisions decision ON decision.attempt_id = latest.id;

CREATE FUNCTION notify_job_admin_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer_owner uuid; provider_owner uuid; recipient_id uuid;
BEGIN
  SELECT customer.owner_user_id, provider.owner_user_id
    INTO customer_owner, provider_owner FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  WHERE job.id = NEW.job_id;
  FOREACH recipient_id IN ARRAY ARRAY[customer_owner, provider_owner] LOOP
    PERFORM insert_exact_notification_outbox_event(
      'job.admin_completion.' || NEW.command_id::text || '.' || recipient_id::text,
      'job.completion.admin_forced', NEW.recorded_at, 'JOB', NEW.job_id::text,
      jsonb_build_object('recipient_user_id', recipient_id::text,
        'job_id', NEW.job_id::text, 'command_id', NEW.command_id::text),
      'job.completion.admin_forced', NEW.command_id::text, NEW.recorded_at
    );
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_admin_completion_notify AFTER INSERT ON job_admin_completion_commands
  FOR EACH ROW EXECUTE FUNCTION notify_job_admin_completion();

-- Keep participant closure evidence derivable, with explicit provenance so
-- downstream verification never mistakes an admin correction for consent.
CREATE OR REPLACE VIEW job_completion_participant_closures AS
SELECT participant.id AS participant_id, participant.job_id,
  decision.decided_at AS closed_at, decision.actor_user_id AS closed_by_user_id,
  decision.id AS completion_decision_id,
  NULL::uuid AS admin_completion_command_id,
  'CUSTOMER_ACCEPTED'::text AS closure_kind
FROM current_job_participants participant
JOIN job_completion_attempts attempt ON attempt.job_id = participant.job_id
JOIN job_completion_decisions decision ON decision.attempt_id = attempt.id
  AND decision.kind = 'ACCEPT'
WHERE participant.state = 'ACCEPTED'
UNION ALL
SELECT participant.id, participant.job_id, admin_completion.recorded_at,
  admin_completion.actor_user_id, NULL::uuid, admin_completion.command_id,
  'ADMIN_FORCED'::text
FROM current_job_participants participant
JOIN job_admin_completion_commands admin_completion
  ON admin_completion.job_id = participant.job_id
WHERE participant.state = 'ACCEPTED';

COMMENT ON TABLE job_admin_completion_commands IS
  'Exceptional audited admin completion, distinct from customer ACCEPT and never actor impersonation.';
