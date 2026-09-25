CREATE TYPE privacy_data_disposition AS ENUM (
  'REVIEW_REQUIRED', 'DELETE', 'ANONYMIZE', 'RETAIN', 'NO_DATA'
);

CREATE TYPE privacy_disposition_state AS ENUM (
  'BLOCKED', 'READY', 'PROCESSING', 'COMPLETED', 'FAILED'
);

-- The unified immutable audit ledger was created before the dedicated privacy
-- capability existed. Keep its authenticated-actor allowlist synchronized so
-- privacy commands cannot bypass the shared audited-command path.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_valid CHECK (
  (
    actor_kind = 'AUTHENTICATED_USER'
    AND actor_user_id IS NOT NULL
    AND actor_system_reference IS NULL
    AND actor_capability IS NOT NULL
    AND actor_capability IN (
      'admin.access',
      'admin.credentials.review',
      'admin.disputes.manage',
      'admin.jobs.correct',
      'admin.profiles.review',
      'admin.profiles.moderate',
      'admin.privacy.manage',
      'admin.reviews.moderate',
      'admin.sensitive.read',
      'admin.users.manage',
      'admin.roles.manage'
    )
  ) OR (
    actor_kind = 'SYSTEM'
    AND actor_user_id IS NULL
    AND actor_system_reference IS NOT NULL
    AND actor_system_reference ~ '^[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND actor_capability IS NULL
  )
);

CREATE VIEW current_privacy_request_cases
WITH (security_invoker = true)
AS
SELECT request.case_id, request.subject_user_id, request.request_type,
  request.received_at, latest.revision, latest.state, latest.deadline_at,
  latest.action_code, latest.actor_user_id, latest.occurred_at
FROM privacy_request_cases request
JOIN LATERAL (
  SELECT event.revision, event.state, event.deadline_at,
    event.action_code, event.actor_user_id, event.occurred_at
  FROM privacy_request_events event
  WHERE event.case_id = request.case_id
  ORDER BY event.revision DESC
  LIMIT 1
) latest ON true;

CREATE TABLE privacy_account_closure_commands (
  command_id uuid PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL,
  expected_request_revision integer NOT NULL CHECK (
    expected_request_revision > 0
  ),
  expected_request_state privacy_request_state NOT NULL CHECK (
    expected_request_state = 'IN_REVIEW'
  ),
  resulting_request_revision integer NOT NULL,
  reason_code text NOT NULL CHECK (
    reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  reason text NOT NULL CHECK (
    reason = btrim(reason)
    AND length(reason) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_account_closure_revision_step CHECK (
    resulting_request_revision = expected_request_revision + 1
  ),
  CONSTRAINT privacy_account_closure_session_hash CHECK (
    actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE privacy_request_admin_commands (
  command_id uuid PRIMARY KEY,
  case_id uuid NOT NULL
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL,
  expected_revision integer NOT NULL CHECK (expected_revision > 0),
  expected_state privacy_request_state NOT NULL,
  resulting_revision integer NOT NULL,
  resulting_state privacy_request_state NOT NULL CHECK (
    resulting_state <> 'RECEIVED'
  ),
  action_code text NOT NULL CHECK (
    action_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  deadline_at timestamptz,
  reason text NOT NULL CHECK (
    reason = btrim(reason)
    AND length(reason) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT privacy_request_admin_revision_step CHECK (
    resulting_revision = expected_revision + 1
  ),
  CONSTRAINT privacy_request_admin_session_hash CHECK (
    actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE privacy_data_disposition_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  category privacy_retention_category NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  disposition privacy_data_disposition NOT NULL,
  state privacy_disposition_state NOT NULL,
  policy_version_id uuid REFERENCES privacy_retention_policy_versions(
    policy_version_id
  ) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_code text NOT NULL CHECK (
    action_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, category, revision),
  CONSTRAINT privacy_disposition_review_shape CHECK (
    (
      disposition = 'REVIEW_REQUIRED'
      AND state = 'BLOCKED'
      AND policy_version_id IS NULL
    )
    OR disposition <> 'REVIEW_REQUIRED'
  )
);

CREATE INDEX privacy_data_disposition_case_idx
  ON privacy_data_disposition_events (case_id, category, revision DESC);

CREATE VIEW current_privacy_data_dispositions
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (event.case_id, event.category)
  event.event_id, event.case_id, event.category, event.revision,
  event.disposition, event.state, event.policy_version_id,
  event.actor_user_id, event.action_code, event.occurred_at
FROM privacy_data_disposition_events event
ORDER BY event.case_id, event.category, event.revision DESC;

CREATE FUNCTION privacy_account_has_open_obligations(subject_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jobs job
    JOIN current_job_states state ON state.job_id = job.id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    WHERE state.state NOT IN ('COMPLETED', 'CANCELLED')
      AND subject_id IN (customer.owner_user_id, provider.owner_user_id)
  ) OR EXISTS (
    SELECT 1
    FROM current_job_participants participant
    JOIN current_job_states state ON state.job_id = participant.job_id
    JOIN craftsman_profiles profile
      ON profile.id = participant.craftsman_profile_id
    WHERE participant.state = 'ACCEPTED'
      AND state.state NOT IN ('COMPLETED', 'CANCELLED')
      AND profile.owner_user_id = subject_id
  ) OR EXISTS (
    SELECT 1
    FROM current_dispute_cases dispute
    JOIN jobs job ON job.id = dispute.job_id
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    WHERE dispute.state NOT IN ('RESOLVED', 'CLOSED')
      AND subject_id IN (customer.owner_user_id, provider.owner_user_id)
  )
$$;

CREATE FUNCTION privacy_admin_session_is_recent(
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

CREATE FUNCTION apply_privacy_account_closure()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE request privacy_request_cases%ROWTYPE;
DECLARE current_event privacy_request_events%ROWTYPE;
DECLARE subject_state user_account_state;
DECLARE category privacy_retention_category;
BEGIN
  NEW.occurred_at := clock_timestamp();

  IF NOT privacy_admin_session_is_recent(
      NEW.actor_privileged_session_hash, NEW.actor_user_id
    ) THEN
    RAISE EXCEPTION 'recent MFA-backed privacy capability required';
  END IF;

  SELECT * INTO request
  FROM privacy_request_cases
  WHERE case_id = NEW.case_id
  FOR UPDATE;
  IF NOT FOUND
    OR request.request_type <> 'ACCOUNT_CLOSURE'
    OR request.subject_user_id <> NEW.subject_user_id THEN
    RAISE EXCEPTION 'matching account-closure request required';
  END IF;

  SELECT * INTO current_event
  FROM privacy_request_events
  WHERE case_id = NEW.case_id
  ORDER BY revision DESC
  LIMIT 1;
  IF current_event.revision IS DISTINCT FROM NEW.expected_request_revision
    OR current_event.state IS DISTINCT FROM NEW.expected_request_state THEN
    RAISE EXCEPTION 'stale privacy request state';
  END IF;

  SELECT account_state INTO subject_state
  FROM users
  WHERE id = NEW.subject_user_id
  FOR UPDATE;
  IF subject_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'active account required for closure';
  END IF;
  IF privacy_account_has_open_obligations(NEW.subject_user_id) THEN
    RAISE EXCEPTION 'account closure blocked by active obligation';
  END IF;

  NEW.resulting_request_revision := NEW.expected_request_revision + 1;
  UPDATE users
  SET account_state = 'DEACTIVATED',
    account_state_changed_at = NEW.occurred_at,
    updated_at = NEW.occurred_at
  WHERE id = NEW.subject_user_id;
  UPDATE auth_sessions
  SET revoked_at = COALESCE(revoked_at, NEW.occurred_at)
  WHERE user_id = NEW.subject_user_id;

  INSERT INTO privacy_request_events (
    event_id, correlation_id, case_id, actor_user_id, revision, state,
    deadline_at, action_code, occurred_at
  ) VALUES (
    NEW.command_id, NEW.command_id, NEW.case_id, NEW.actor_user_id,
    NEW.resulting_request_revision, 'ACTION_REQUIRED',
    current_event.deadline_at,
    'ACCOUNT_DEACTIVATED_CATEGORY_REVIEW_PENDING', NEW.occurred_at
  );

  FOR category IN SELECT unnest(enum_range(NULL::privacy_retention_category))
  LOOP
    INSERT INTO privacy_data_disposition_events (
      case_id, category, revision, disposition, state,
      actor_user_id, action_code, occurred_at
    ) VALUES (
      NEW.case_id, category, 1, 'REVIEW_REQUIRED', 'BLOCKED',
      NEW.actor_user_id, 'LEGAL_POLICY_REVIEW_REQUIRED', NEW.occurred_at
    );
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION apply_privacy_request_admin_command()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE request privacy_request_cases%ROWTYPE;
DECLARE current_event privacy_request_events%ROWTYPE;
DECLARE category_count integer;
DECLARE completed_count integer;
BEGIN
  NEW.occurred_at := clock_timestamp();
  IF NOT privacy_admin_session_is_recent(
      NEW.actor_privileged_session_hash, NEW.actor_user_id
    ) THEN
    RAISE EXCEPTION 'recent MFA-backed privacy capability required';
  END IF;

  SELECT * INTO request FROM privacy_request_cases
  WHERE case_id = NEW.case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'privacy request required'; END IF;
  SELECT * INTO current_event FROM privacy_request_events
  WHERE case_id = NEW.case_id
  ORDER BY revision DESC LIMIT 1;
  IF current_event.revision IS DISTINCT FROM NEW.expected_revision
    OR current_event.state IS DISTINCT FROM NEW.expected_state THEN
    RAISE EXCEPTION 'stale privacy request state';
  END IF;
  IF NOT (
    (NEW.expected_state = 'RECEIVED'
      AND NEW.resulting_state IN ('IDENTITY_VERIFICATION_PENDING', 'VERIFIED'))
    OR (NEW.expected_state = 'IDENTITY_VERIFICATION_PENDING'
      AND NEW.resulting_state IN ('VERIFIED', 'REJECTED'))
    OR (NEW.expected_state = 'VERIFIED'
      AND NEW.resulting_state = 'IN_REVIEW')
    OR (NEW.expected_state = 'IN_REVIEW'
      AND NEW.resulting_state IN ('ACTION_REQUIRED', 'COMPLETED', 'REJECTED'))
    OR (NEW.expected_state = 'ACTION_REQUIRED'
      AND NEW.resulting_state IN ('IN_REVIEW', 'COMPLETED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid privacy request transition';
  END IF;

  IF NEW.resulting_state = 'COMPLETED'
    AND request.request_type IN ('ERASURE', 'ACCOUNT_CLOSURE') THEN
    SELECT count(*) INTO category_count
    FROM unnest(enum_range(NULL::privacy_retention_category));
    SELECT count(*) INTO completed_count
    FROM current_privacy_data_dispositions disposition
    WHERE disposition.case_id = NEW.case_id
      AND disposition.disposition <> 'REVIEW_REQUIRED'
      AND disposition.state = 'COMPLETED';
    IF completed_count <> category_count THEN
      RAISE EXCEPTION 'all privacy category dispositions must complete';
    END IF;
  END IF;

  NEW.resulting_revision := NEW.expected_revision + 1;
  INSERT INTO privacy_request_events (
    event_id, correlation_id, case_id, actor_user_id, revision,
    state, deadline_at, action_code, occurred_at
  ) VALUES (
    NEW.command_id, NEW.command_id, NEW.case_id, NEW.actor_user_id,
    NEW.resulting_revision, NEW.resulting_state, NEW.deadline_at,
    NEW.action_code, NEW.occurred_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_request_admin_command_apply
BEFORE INSERT ON privacy_request_admin_commands
FOR EACH ROW EXECUTE FUNCTION apply_privacy_request_admin_command();

CREATE TRIGGER privacy_account_closure_apply
BEFORE INSERT ON privacy_account_closure_commands
FOR EACH ROW EXECUTE FUNCTION apply_privacy_account_closure();

CREATE FUNCTION validate_privacy_data_disposition_event()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE current_event privacy_data_disposition_events%ROWTYPE;
DECLARE policy privacy_retention_policy_versions%ROWTYPE;
DECLARE request privacy_request_cases%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  SELECT * INTO request FROM privacy_request_cases
  WHERE case_id = NEW.case_id FOR SHARE;
  IF NOT FOUND OR request.request_type NOT IN ('ERASURE', 'ACCOUNT_CLOSURE') THEN
    RAISE EXCEPTION 'erasure or account-closure request required';
  END IF;

  SELECT * INTO current_event
  FROM privacy_data_disposition_events
  WHERE case_id = NEW.case_id AND category = NEW.category
  ORDER BY revision DESC LIMIT 1
  FOR UPDATE;
  IF current_event.revision IS NULL THEN
    IF NEW.revision <> 1 OR NEW.disposition <> 'REVIEW_REQUIRED'
      OR NEW.state <> 'BLOCKED' OR NEW.policy_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'initial category disposition must require review';
    END IF;
  ELSE
    IF NEW.revision <> current_event.revision + 1 THEN
      RAISE EXCEPTION 'privacy disposition revisions must be contiguous';
    END IF;
    IF NEW.disposition = 'REVIEW_REQUIRED' THEN
      RAISE EXCEPTION 'resolved category cannot return to unscoped review';
    END IF;
    IF NEW.policy_version_id IS NULL THEN
      RAISE EXCEPTION 'reviewed category policy required';
    END IF;
    SELECT * INTO policy
    FROM privacy_retention_policy_versions
    WHERE policy_version_id = NEW.policy_version_id
      AND category = NEW.category
      AND legal_review_state = 'APPROVED'
      AND launch_state = 'READY';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approved ready category policy required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_data_disposition_validate
BEFORE INSERT ON privacy_data_disposition_events
FOR EACH ROW EXECUTE FUNCTION validate_privacy_data_disposition_event();

CREATE FUNCTION prevent_privacy_operational_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy operational history is append-only';
END;
$$;

CREATE TRIGGER privacy_account_closure_commands_immutable
BEFORE UPDATE OR DELETE ON privacy_account_closure_commands
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

CREATE TRIGGER privacy_request_admin_commands_immutable
BEFORE UPDATE OR DELETE ON privacy_request_admin_commands
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

CREATE TRIGGER privacy_data_disposition_events_immutable
BEFORE UPDATE OR DELETE ON privacy_data_disposition_events
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_operational_history_mutation();

COMMENT ON TABLE privacy_account_closure_commands IS
  'MFA-backed account deactivation after open-obligation checks. It revokes access and public exposure without deleting shared transactional history.';
COMMENT ON TABLE privacy_data_disposition_events IS
  'Category-by-category append-only delete/anonymize/retain decisions. Initial rows remain BLOCKED until a legally reviewed READY category policy exists.';
COMMENT ON FUNCTION privacy_account_has_open_obligations(uuid) IS
  'Conservative closure blocker for active customer/provider/participant Jobs and unresolved disputes.';
