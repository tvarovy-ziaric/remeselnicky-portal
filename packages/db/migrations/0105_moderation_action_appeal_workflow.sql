-- R4-023: reports are independent claims. Decisions, enforcement and appeals
-- are separate append-only records with recent-MFA audit provenance.
ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_reporter_user_id_target_type_target_id_key;
ALTER TABLE moderation_reports
  ADD COLUMN evidence_reference_type text,
  ADD COLUMN evidence_reference_id uuid,
  ADD CONSTRAINT moderation_report_evidence_reference_complete CHECK (
    (evidence_reference_type IS NULL AND evidence_reference_id IS NULL)
    OR (
      evidence_reference_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND evidence_reference_id IS NOT NULL
    )
  );

CREATE FUNCTION moderation_target_is_reportable(
  candidate_type moderation_report_target_type,
  candidate_id uuid,
  actor_id uuid
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
BEGIN
  IF candidate_type = 'MAIN_REVIEW' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_unlocked_job_main_reviews review
      WHERE review.revision_id = candidate_id
        AND review.direction = 'CUSTOMER_TO_PROVIDER'
        AND review.target_kind = 'CRAFTSMAN_PROFILE'
    );
  ELSIF candidate_type = 'REVIEW_RESPONSE' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_job_main_review_responses response
      JOIN current_unlocked_job_main_reviews review
        ON review.revision_id = response.review_revision_id
      WHERE response.response_id = candidate_id
        AND review.direction = 'CUSTOMER_TO_PROVIDER'
        AND review.target_kind = 'CRAFTSMAN_PROFILE'
    );
  ELSIF candidate_type = 'SUPERVISOR_EVALUATION' THEN
    RETURN EXISTS (
      SELECT 1 FROM job_supervisor_evaluations evaluation
      JOIN job_participants participant
        ON participant.id = evaluation.target_participant_id
      JOIN craftsman_profiles profile
        ON profile.id = participant.craftsman_profile_id
      WHERE evaluation.evaluation_id = candidate_id
        AND profile.owner_user_id = actor_id
    );
  ELSIF candidate_type = 'JOB_CONTEXT_REVIEW' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_job_context_reviews review
      WHERE review.review_id = candidate_id
        AND job_milestone_actor_role(review.job_id, actor_id) IS NOT NULL
    );
  ELSIF candidate_type = 'CRAFTSMAN_PROFILE' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_craftsman_profile_publications publication
      WHERE publication.craftsman_profile_id = candidate_id
        AND publication.effectively_public
    );
  ELSIF candidate_type = 'PORTFOLIO_PROJECT' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_public_portfolio_projects project
      WHERE project.portfolio_project_id = candidate_id
    );
  ELSIF candidate_type = 'MEDIA_ASSET' THEN
    RETURN EXISTS (
      SELECT 1 FROM media_assets asset
      WHERE asset.id = candidate_id
        AND (
          asset.owner_user_id = actor_id
          OR asset.uploaded_by_user_id = actor_id
          OR EXISTS (
            SELECT 1 FROM current_public_portfolio_project_photos photo
            WHERE photo.media_asset_id = asset.id
          )
        )
    );
  ELSIF candidate_type = 'MESSAGE' THEN
    RETURN EXISTS (
      SELECT 1 FROM conversation_timeline_entries message
      WHERE message.id = candidate_id
        AND message.entry_kind = 'HUMAN_MESSAGE'
        AND conversation_participant_is_active(
          message.conversation_id, actor_id, false
        )
    );
  ELSIF candidate_type = 'CONVERSATION' THEN
    RETURN conversation_participant_is_active(candidate_id, actor_id, false);
  ELSIF candidate_type = 'JOB_ATTACHMENT' THEN
    RETURN EXISTS (
      SELECT 1 FROM media_assets asset
      WHERE asset.id = candidate_id
        AND asset.provenance_entity_type IS NOT NULL
        AND (asset.owner_user_id = actor_id OR asset.uploaded_by_user_id = actor_id)
    );
  ELSIF candidate_type = 'JOB_REQUEST' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_job_requests request
      JOIN job_invitations invitation
        ON invitation.job_request_id = request.id
      JOIN craftsman_profiles profile
        ON profile.id = invitation.craftsman_profile_id
      WHERE request.id = candidate_id AND request.state = 'ACTIVE'
        AND profile.owner_user_id = actor_id
    );
  ELSIF candidate_type = 'USER_BEHAVIOR' THEN
    RETURN candidate_id IS DISTINCT FROM actor_id AND EXISTS (
      SELECT 1 FROM users target WHERE target.id = candidate_id
    );
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION validate_moderation_report()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior moderation_reports%ROWTYPE;
DECLARE mirrored_reported_at timestamptz;
BEGIN
  SELECT * INTO prior FROM moderation_reports WHERE report_id = NEW.report_id;
  IF FOUND THEN
    IF prior.reporter_user_id IS NOT DISTINCT FROM NEW.reporter_user_id
      AND prior.target_type IS NOT DISTINCT FROM NEW.target_type
      AND prior.target_id IS NOT DISTINCT FROM NEW.target_id
      AND prior.reason IS NOT DISTINCT FROM NEW.reason
      AND prior.details IS NOT DISTINCT FROM NEW.details
      AND prior.evidence_reference_type IS NOT DISTINCT FROM NEW.evidence_reference_type
      AND prior.evidence_reference_id IS NOT DISTINCT FROM NEW.evidence_reference_id THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'moderation report identifier reuse conflict';
  END IF;

  -- Existing conversation reports predate this unified queue. Preserve their
  -- exact provenance even when the reporter is no longer ACTIVE; this branch
  -- accepts only a byte-for-byte derivation from the immutable source row.
  SELECT report.created_at INTO mirrored_reported_at
  FROM conversation_reports report
  WHERE report.id = NEW.report_id
    AND report.reporter_user_id = NEW.reporter_user_id
    AND NEW.target_type = CASE WHEN report.message_id IS NULL
      THEN 'CONVERSATION'::moderation_report_target_type
      ELSE 'MESSAGE'::moderation_report_target_type END
    AND NEW.target_id = coalesce(report.message_id, report.conversation_id)
    AND NEW.reason = CASE report.reason
      WHEN 'ABUSE' THEN 'HARASSMENT_ABUSE'::moderation_report_reason
      WHEN 'CONTACT_CIRCUMVENTION' THEN 'PLATFORM_BYPASS_ATTEMPT'::moderation_report_reason
      WHEN 'FRAUD_OR_SCAM' THEN 'SUSPICIOUS_PAYMENT_SCAM'::moderation_report_reason
      WHEN 'THREAT' THEN 'THREATS'::moderation_report_reason
      ELSE 'OTHER'::moderation_report_reason END
    AND NEW.details IS NULL
    AND NEW.evidence_reference_type = 'CONVERSATION'
    AND NEW.evidence_reference_id = report.conversation_id;
  IF FOUND THEN
    NEW.reported_at := mirrored_reported_at;
    RETURN NEW;
  END IF;

  PERFORM 1 FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.reporter_user_id AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN RAISE EXCEPTION 'active verified reporter required'; END IF;
  IF NOT moderation_target_is_reportable(
      NEW.target_type, NEW.target_id, NEW.reporter_user_id
    ) THEN
    RAISE EXCEPTION 'reportable visible target required';
  END IF;
  NEW.reported_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TYPE moderation_admin_action AS ENUM (
  'START_REVIEW', 'FIND_NO_VIOLATION', 'APPLY_WARNING', 'HIDE_CONTENT',
  'EXCLUDE_REVIEW_EVIDENCE', 'APPLY_FEATURE_RESTRICTION',
  'APPLY_TEMPORARY_SUSPENSION', 'APPLY_INDEFINITE_SUSPENSION',
  'CLOSE', 'REOPEN'
);
CREATE TYPE moderation_enforcement_scope AS ENUM (
  'CONTENT', 'MESSAGING', 'PUBLISHING', 'QUOTING', 'REVIEWS', 'ACCOUNT'
);
CREATE TYPE moderation_action_source AS ENUM (
  'REPORT', 'ADMIN_OBSERVATION', 'AUTOMATED_RISK', 'DISPUTE_OUTCOME'
);
CREATE TYPE moderation_appeal_state AS ENUM (
  'OPEN', 'UPHELD', 'REDUCED', 'REVERSED'
);
CREATE TYPE moderation_appeal_decision AS ENUM (
  'UPHOLD', 'REDUCE', 'REVERSE'
);

CREATE TABLE moderation_admin_commands (
  command_id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES moderation_reports(report_id) ON DELETE RESTRICT,
  action moderation_admin_action NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL,
  expected_state moderation_report_state NOT NULL,
  resulting_state moderation_report_state,
  reason text NOT NULL,
  policy_category text,
  policy_reason_code text,
  policy_version text,
  private_admin_note text,
  subject_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  enforcement_scope moderation_enforcement_scope,
  restriction_expires_at timestamptz,
  user_facing_reason text,
  prior_state jsonb,
  payload_fingerprint char(64) NOT NULL,
  audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_events(event_id)
    DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT moderation_admin_session_hash CHECK (
    actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT moderation_admin_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT moderation_admin_reason_safe CHECK (audit_reason_is_safe(reason)),
  CONSTRAINT moderation_admin_policy_safe CHECK (
    (policy_category IS NULL OR policy_category ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (policy_reason_code IS NULL OR policy_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (policy_version IS NULL OR policy_version ~ '^[A-Z0-9][A-Z0-9_.:-]{0,63}$')
  ),
  CONSTRAINT moderation_admin_note_safe CHECK (
    private_admin_note IS NULL OR (
      private_admin_note = btrim(private_admin_note)
      AND length(private_admin_note) BETWEEN 1 AND 4000
      AND private_admin_note !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT moderation_admin_user_reason_safe CHECK (
    user_facing_reason IS NULL OR (
      user_facing_reason = btrim(user_facing_reason)
      AND length(user_facing_reason) BETWEEN 8 AND 1000
      AND user_facing_reason !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT moderation_admin_prior_state_object CHECK (
    prior_state IS NULL OR jsonb_typeof(prior_state) = 'object'
  )
);

ALTER TABLE moderation_report_state_events
  ADD COLUMN admin_command_id uuid UNIQUE
    REFERENCES moderation_admin_commands(command_id) ON DELETE RESTRICT;
ALTER TABLE moderation_report_state_events
  DROP CONSTRAINT moderation_report_state_origin;
ALTER TABLE moderation_report_state_events
  ADD CONSTRAINT moderation_report_state_origin CHECK (
    (
      version = 1 AND state = 'OPEN' AND source = 'REPORTER'
      AND policy_reason_code IS NULL AND private_admin_note IS NULL
      AND admin_command_id IS NULL
    ) OR (
      version > 1 AND source = 'ADMIN' AND policy_reason_code IS NOT NULL
      AND admin_command_id IS NOT NULL
    )
  );

CREATE TABLE moderation_actions (
  action_id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES moderation_reports(report_id) ON DELETE RESTRICT,
  admin_command_id uuid NOT NULL UNIQUE
    REFERENCES moderation_admin_commands(command_id) ON DELETE RESTRICT,
  action moderation_admin_action NOT NULL,
  source moderation_action_source NOT NULL,
  target_type moderation_report_target_type NOT NULL,
  target_id uuid NOT NULL,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  enforcement_scope moderation_enforcement_scope NOT NULL,
  restriction_expires_at timestamptz,
  policy_category text NOT NULL,
  policy_reason_code text NOT NULL,
  policy_version text NOT NULL,
  user_facing_reason text NOT NULL,
  prior_state jsonb NOT NULL,
  applied_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL,
  CONSTRAINT moderation_action_policy_safe CHECK (
    policy_category ~ '^[A-Z][A-Z0-9_.:-]{2,95}$'
    AND policy_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$'
    AND policy_version ~ '^[A-Z0-9][A-Z0-9_.:-]{0,63}$'
  ),
  CONSTRAINT moderation_action_user_reason_safe CHECK (
    user_facing_reason = btrim(user_facing_reason)
    AND length(user_facing_reason) BETWEEN 8 AND 1000
    AND user_facing_reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT moderation_action_prior_state_object CHECK (
    jsonb_typeof(prior_state) = 'object'
  )
);

CREATE TABLE moderation_risk_flags (
  flag_id uuid PRIMARY KEY,
  target_type moderation_report_target_type NOT NULL,
  target_id uuid NOT NULL,
  source moderation_action_source NOT NULL,
  source_reference_id uuid,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$'),
  created_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_by_system_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT moderation_risk_flag_actor CHECK (
    (created_by_user_id IS NOT NULL) <> (created_by_system_reference IS NOT NULL)
  )
);

CREATE FUNCTION moderation_admin_session_is_recent(
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

CREATE FUNCTION moderation_target_subject_user(
  candidate_type moderation_report_target_type,
  candidate_id uuid
)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE subject_id uuid;
BEGIN
  IF candidate_type = 'MAIN_REVIEW' THEN
    SELECT review.actor_user_id INTO subject_id
    FROM current_unlocked_job_main_reviews review
    WHERE review.revision_id = candidate_id;
  ELSIF candidate_type = 'REVIEW_RESPONSE' THEN
    SELECT response.author_user_id INTO subject_id
    FROM job_main_review_responses response
    WHERE response.response_id = candidate_id;
  ELSIF candidate_type = 'JOB_CONTEXT_REVIEW' THEN
    SELECT review.author_user_id INTO subject_id
    FROM current_job_context_reviews review
    WHERE review.review_id = candidate_id;
  ELSIF candidate_type = 'SUPERVISOR_EVALUATION' THEN
    SELECT evaluation.evaluator_user_id INTO subject_id
    FROM job_supervisor_evaluations evaluation
    WHERE evaluation.evaluation_id = candidate_id;
  ELSIF candidate_type = 'CRAFTSMAN_PROFILE' THEN
    SELECT profile.owner_user_id INTO subject_id
    FROM craftsman_profiles profile WHERE profile.id = candidate_id;
  ELSIF candidate_type = 'PORTFOLIO_PROJECT' THEN
    SELECT profile.owner_user_id INTO subject_id
    FROM portfolio_projects project
    JOIN craftsman_profiles profile ON profile.id = project.craftsman_profile_id
    WHERE project.id = candidate_id;
  ELSIF candidate_type IN ('MEDIA_ASSET', 'JOB_ATTACHMENT') THEN
    SELECT asset.owner_user_id INTO subject_id
    FROM media_assets asset WHERE asset.id = candidate_id;
  ELSIF candidate_type = 'MESSAGE' THEN
    SELECT message.author_user_id INTO subject_id
    FROM conversation_timeline_entries message WHERE message.id = candidate_id;
  ELSIF candidate_type = 'JOB_REQUEST' THEN
    SELECT customer.owner_user_id INTO subject_id
    FROM job_requests request
    JOIN customer_profiles customer ON customer.id = request.customer_profile_id
    WHERE request.id = candidate_id;
  ELSIF candidate_type = 'USER_BEHAVIOR' THEN
    subject_id := candidate_id;
  END IF;
  RETURN subject_id;
END;
$$;

CREATE FUNCTION validate_moderation_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state moderation_report_state;
DECLARE report moderation_reports%ROWTYPE;
DECLARE is_effect boolean;
DECLARE resolved_subject uuid;
BEGIN
  SELECT * INTO report FROM moderation_reports
  WHERE report_id = NEW.report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'moderation report required'; END IF;
  SELECT state INTO current_state FROM current_moderation_report_states
  WHERE report_id = NEW.report_id;
  IF current_state IS DISTINCT FROM NEW.expected_state THEN
    RAISE EXCEPTION 'stale moderation report state';
  END IF;
  IF NOT moderation_admin_session_is_recent(
      NEW.actor_privileged_session_hash, NEW.actor_user_id
    ) THEN
    RAISE EXCEPTION 'recent MFA-backed moderation capability required';
  END IF;
  IF NEW.actor_user_id = report.reporter_user_id THEN
    RAISE EXCEPTION 'reporter cannot decide own moderation report';
  END IF;

  is_effect := NEW.action IN (
    'APPLY_WARNING', 'HIDE_CONTENT', 'EXCLUDE_REVIEW_EVIDENCE',
    'APPLY_FEATURE_RESTRICTION', 'APPLY_TEMPORARY_SUSPENSION',
    'APPLY_INDEFINITE_SUSPENSION'
  );
  NEW.resulting_state := CASE NEW.action
    WHEN 'START_REVIEW' THEN 'UNDER_REVIEW'::moderation_report_state
    WHEN 'FIND_NO_VIOLATION' THEN 'NO_VIOLATION'::moderation_report_state
    WHEN 'CLOSE' THEN 'CLOSED'::moderation_report_state
    WHEN 'REOPEN' THEN 'UNDER_REVIEW'::moderation_report_state
    ELSE 'ACTIONED'::moderation_report_state
  END;
  IF (NEW.action = 'START_REVIEW' AND current_state <> 'OPEN')
      OR (NEW.action = 'FIND_NO_VIOLATION' AND current_state <> 'UNDER_REVIEW')
      OR (is_effect AND current_state <> 'UNDER_REVIEW')
      OR (NEW.action = 'CLOSE' AND current_state NOT IN ('ACTIONED', 'NO_VIOLATION'))
      OR (NEW.action = 'REOPEN' AND current_state <> 'CLOSED') THEN
    RAISE EXCEPTION 'invalid moderation report transition';
  END IF;

  IF NEW.action IN ('FIND_NO_VIOLATION') OR is_effect THEN
    IF NEW.policy_category IS NULL OR NEW.policy_reason_code IS NULL
        OR NEW.policy_version IS NULL THEN
      RAISE EXCEPTION 'stable moderation policy reason required';
    END IF;
  ELSIF NEW.policy_category IS NOT NULL OR NEW.policy_reason_code IS NOT NULL
      OR NEW.policy_version IS NOT NULL OR NEW.private_admin_note IS NOT NULL THEN
    RAISE EXCEPTION 'workflow-only command cannot carry decision data';
  END IF;

  IF is_effect THEN
    IF NEW.subject_user_id IS NULL OR NEW.enforcement_scope IS NULL
        OR NEW.user_facing_reason IS NULL OR NEW.prior_state IS NULL THEN
      RAISE EXCEPTION 'moderation effect and user notice are required';
    END IF;
    resolved_subject := moderation_target_subject_user(
      report.target_type, report.target_id
    );
    IF resolved_subject IS NULL AND report.target_type = 'CONVERSATION'
        AND NOT EXISTS (
          SELECT 1 FROM current_conversations conversation
          JOIN customer_profiles customer
            ON customer.id = conversation.customer_profile_id
          JOIN craftsman_profiles provider
            ON provider.id = conversation.craftsman_profile_id
          WHERE conversation.id = report.target_id
            AND NEW.subject_user_id IN (
              customer.owner_user_id, provider.owner_user_id
            )
        ) THEN
      RAISE EXCEPTION 'moderation subject must be a conversation participant';
    ELSIF resolved_subject IS NOT NULL
        AND NEW.subject_user_id IS DISTINCT FROM resolved_subject THEN
      RAISE EXCEPTION 'moderation subject must match target owner';
    END IF;
  ELSE
    IF NEW.subject_user_id IS NOT NULL OR NEW.enforcement_scope IS NOT NULL
        OR NEW.restriction_expires_at IS NOT NULL
        OR NEW.user_facing_reason IS NOT NULL OR NEW.prior_state IS NOT NULL THEN
      RAISE EXCEPTION 'non-effect command cannot carry enforcement data';
    END IF;
  END IF;

  IF NEW.action IN ('APPLY_WARNING', 'HIDE_CONTENT', 'EXCLUDE_REVIEW_EVIDENCE')
      AND (NEW.enforcement_scope <> 'CONTENT'
        OR NEW.restriction_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'content moderation effect shape is invalid';
  ELSIF NEW.action = 'APPLY_FEATURE_RESTRICTION'
      AND (NEW.enforcement_scope IN ('CONTENT', 'ACCOUNT')
        OR NEW.restriction_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'feature restriction shape is invalid';
  ELSIF NEW.action = 'APPLY_TEMPORARY_SUSPENSION'
      AND (NEW.enforcement_scope = 'CONTENT'
        OR NEW.restriction_expires_at IS NULL
        OR NEW.restriction_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'future temporary restriction expiry required';
  ELSIF NEW.action = 'APPLY_INDEFINITE_SUSPENSION'
      AND (NEW.enforcement_scope <> 'ACCOUNT'
        OR NEW.restriction_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'indefinite account suspension shape is invalid';
  END IF;

  IF NEW.action = 'EXCLUDE_REVIEW_EVIDENCE'
      AND report.target_type NOT IN (
        'MAIN_REVIEW', 'JOB_CONTEXT_REVIEW', 'SUPERVISOR_EVALUATION'
      ) THEN
    RAISE EXCEPTION 'review evidence action requires review target';
  END IF;
  IF NEW.action = 'HIDE_CONTENT'
      AND report.target_type NOT IN (
        'CRAFTSMAN_PROFILE', 'MAIN_REVIEW', 'REVIEW_RESPONSE',
        'PORTFOLIO_PROJECT', 'MEDIA_ASSET', 'MESSAGE', 'JOB_ATTACHMENT'
      ) THEN
    RAISE EXCEPTION 'content hide requires individually hideable target';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_admin_command_validate
BEFORE INSERT ON moderation_admin_commands
FOR EACH ROW EXECUTE FUNCTION validate_moderation_admin_command();

CREATE OR REPLACE FUNCTION validate_moderation_report_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE report moderation_reports%ROWTYPE;
DECLARE prior moderation_report_state_events%ROWTYPE;
DECLARE latest moderation_report_state_events%ROWTYPE;
DECLARE command moderation_admin_commands%ROWTYPE;
BEGIN
  SELECT * INTO prior FROM moderation_report_state_events
  WHERE state_event_id = NEW.state_event_id;
  IF FOUND THEN
    IF prior.report_id IS NOT DISTINCT FROM NEW.report_id
      AND prior.version IS NOT DISTINCT FROM NEW.version
      AND prior.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND prior.state IS NOT DISTINCT FROM NEW.state
      AND prior.source IS NOT DISTINCT FROM NEW.source
      AND prior.policy_reason_code IS NOT DISTINCT FROM NEW.policy_reason_code
      AND prior.private_admin_note IS NOT DISTINCT FROM NEW.private_admin_note
      AND prior.admin_command_id IS NOT DISTINCT FROM NEW.admin_command_id THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'report state event identifier reuse conflict';
  END IF;
  SELECT * INTO report FROM moderation_reports
  WHERE report_id = NEW.report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'moderation report required'; END IF;
  SELECT * INTO latest FROM moderation_report_state_events event
  WHERE event.report_id = NEW.report_id
  ORDER BY event.version DESC LIMIT 1;
  IF latest.state_event_id IS NULL THEN
    IF pg_trigger_depth() < 2 OR NEW.version <> 1 OR NEW.state <> 'OPEN'
      OR NEW.source <> 'REPORTER'
      OR NEW.actor_user_id IS DISTINCT FROM report.reporter_user_id
      OR NEW.state_event_id IS DISTINCT FROM report.report_id
      OR NEW.admin_command_id IS NOT NULL THEN
      RAISE EXCEPTION 'exact initial report state required';
    END IF;
  ELSE
    SELECT * INTO command FROM moderation_admin_commands
    WHERE command_id = NEW.admin_command_id;
    IF pg_trigger_depth() < 2 OR command.command_id IS NULL
      OR command.report_id IS DISTINCT FROM NEW.report_id
      OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id
      OR command.expected_state IS DISTINCT FROM latest.state
      OR command.resulting_state IS DISTINCT FROM NEW.state
      OR NEW.version <> latest.version + 1
      OR NEW.source <> 'ADMIN'
      OR NEW.state_event_id IS DISTINCT FROM command.command_id
      OR NEW.recorded_at IS DISTINCT FROM command.recorded_at THEN
      RAISE EXCEPTION 'admin report state must derive from audited command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION apply_moderation_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_version integer;
DECLARE report moderation_reports%ROWTYPE;
BEGIN
  SELECT * INTO report FROM moderation_reports WHERE report_id = NEW.report_id;
  SELECT coalesce(max(version), 0) + 1 INTO next_version
  FROM moderation_report_state_events WHERE report_id = NEW.report_id;
  INSERT INTO moderation_report_state_events (
    state_event_id, report_id, version, actor_user_id, state, source,
    policy_reason_code, private_admin_note, recorded_at, admin_command_id
  ) VALUES (
    NEW.command_id, NEW.report_id, next_version, NEW.actor_user_id,
    NEW.resulting_state, 'ADMIN',
    coalesce(NEW.policy_reason_code, 'WORKFLOW_' || NEW.action::text),
    NEW.private_admin_note, NEW.recorded_at, NEW.command_id
  );

  IF NEW.action IN (
    'APPLY_WARNING', 'HIDE_CONTENT', 'EXCLUDE_REVIEW_EVIDENCE',
    'APPLY_FEATURE_RESTRICTION', 'APPLY_TEMPORARY_SUSPENSION',
    'APPLY_INDEFINITE_SUSPENSION'
  ) THEN
    INSERT INTO moderation_actions (
      action_id, report_id, admin_command_id, action, source,
      target_type, target_id, subject_user_id, enforcement_scope,
      restriction_expires_at, policy_category, policy_reason_code,
      policy_version, user_facing_reason, prior_state,
      applied_by_user_id, applied_at
    ) VALUES (
      NEW.command_id, NEW.report_id, NEW.command_id, NEW.action, 'REPORT',
      report.target_type, report.target_id, NEW.subject_user_id,
      NEW.enforcement_scope, NEW.restriction_expires_at,
      NEW.policy_category, NEW.policy_reason_code, NEW.policy_version,
      NEW.user_facing_reason, NEW.prior_state,
      NEW.actor_user_id, NEW.recorded_at
    );
    PERFORM insert_exact_notification_outbox_event(
      'moderation:action:' || NEW.command_id::text || ':' || NEW.subject_user_id::text,
      'moderation.action.applied', NEW.recorded_at,
      'MODERATION_ACTION', NEW.command_id::text,
      jsonb_build_object(
        'recipient_user_id', NEW.subject_user_id::text,
        'action_id', NEW.command_id::text,
        'action', NEW.action::text,
        'general_reason_category', NEW.policy_category
      ),
      'moderation.action.applied', NEW.command_id::text, NEW.recorded_at
    );
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderation_admin_command_apply
AFTER INSERT ON moderation_admin_commands
FOR EACH ROW EXECUTE FUNCTION apply_moderation_admin_command();

CREATE FUNCTION require_moderation_admin_command_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_action text;
BEGIN
  expected_action := CASE NEW.action
    WHEN 'START_REVIEW' THEN 'admin.moderation.review_started'
    WHEN 'FIND_NO_VIOLATION' THEN 'admin.moderation.no_violation_found'
    WHEN 'APPLY_WARNING' THEN 'admin.moderation.warning_applied'
    WHEN 'HIDE_CONTENT' THEN 'admin.moderation.content_hidden'
    WHEN 'EXCLUDE_REVIEW_EVIDENCE' THEN 'admin.moderation.review_evidence_excluded'
    WHEN 'APPLY_FEATURE_RESTRICTION' THEN 'admin.moderation.feature_restricted'
    WHEN 'APPLY_TEMPORARY_SUSPENSION' THEN 'admin.moderation.temporary_suspension_applied'
    WHEN 'APPLY_INDEFINITE_SUSPENSION' THEN 'admin.moderation.indefinite_suspension_applied'
    WHEN 'CLOSE' THEN 'admin.moderation.report_closed'
    WHEN 'REOPEN' THEN 'admin.moderation.report_reopened'
  END;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.event_id = NEW.audit_event_id
      AND audit.correlation_id = NEW.command_id
      AND audit.category = 'PRIVILEGED_COMMAND'
      AND audit.action_type = expected_action
      AND audit.actor_kind = 'AUTHENTICATED_USER'
      AND audit.actor_user_id = NEW.actor_user_id
      AND audit.actor_capability = 'admin.reviews.moderate'
      AND audit.target_type = 'MODERATION_REPORT'
      AND audit.target_id = NEW.report_id::text
      AND audit.reason = NEW.reason
  ) THEN
    RAISE EXCEPTION 'matching immutable moderation command audit event required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER moderation_admin_command_audit_required
AFTER INSERT ON moderation_admin_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_moderation_admin_command_audit();

CREATE TABLE moderation_appeals (
  appeal_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES moderation_actions(action_id) ON DELETE RESTRICT,
  appellant_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  explanation text NOT NULL,
  evidence_reference_type text,
  evidence_reference_id uuid,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (action_id, appellant_user_id),
  CONSTRAINT moderation_appeal_explanation_safe CHECK (
    explanation = btrim(explanation) AND length(explanation) BETWEEN 1 AND 4000
      AND explanation !~ '[[:cntrl:]]'
  ),
  CONSTRAINT moderation_appeal_evidence_complete CHECK (
    (evidence_reference_type IS NULL AND evidence_reference_id IS NULL)
    OR (
      evidence_reference_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND evidence_reference_id IS NOT NULL
    )
  )
);

CREATE TABLE moderation_appeal_state_events (
  state_event_id uuid PRIMARY KEY,
  appeal_id uuid NOT NULL REFERENCES moderation_appeals(appeal_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  state moderation_appeal_state NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admin_command_id uuid UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (appeal_id, version)
);

CREATE TABLE moderation_appeal_admin_commands (
  command_id uuid PRIMARY KEY,
  appeal_id uuid NOT NULL REFERENCES moderation_appeals(appeal_id) ON DELETE RESTRICT,
  decision moderation_appeal_decision NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_privileged_session_hash char(64) NOT NULL,
  expected_state moderation_appeal_state NOT NULL,
  reason text NOT NULL CHECK (audit_reason_is_safe(reason)),
  policy_reason_code text NOT NULL
    CHECK (policy_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$'),
  policy_version text NOT NULL
    CHECK (policy_version ~ '^[A-Z0-9][A-Z0-9_.:-]{0,63}$'),
  private_admin_note text,
  reduced_scope moderation_enforcement_scope,
  reduced_expires_at timestamptz,
  user_facing_reason text NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  audit_event_id uuid NOT NULL UNIQUE REFERENCES audit_events(event_id)
    DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT moderation_appeal_admin_session_hash CHECK (
    actor_privileged_session_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT moderation_appeal_admin_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT moderation_appeal_admin_note_safe CHECK (
    private_admin_note IS NULL OR (
      private_admin_note = btrim(private_admin_note)
      AND length(private_admin_note) BETWEEN 1 AND 4000
      AND private_admin_note !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT moderation_appeal_admin_user_reason_safe CHECK (
    user_facing_reason = btrim(user_facing_reason)
    AND length(user_facing_reason) BETWEEN 8 AND 1000
    AND user_facing_reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT moderation_appeal_reduction_shape CHECK (
    (decision = 'REDUCE' AND reduced_scope IS NOT NULL)
    OR (decision <> 'REDUCE' AND reduced_scope IS NULL AND reduced_expires_at IS NULL)
  )
);

ALTER TABLE moderation_appeal_state_events
  ADD CONSTRAINT moderation_appeal_state_admin_command_fk
  FOREIGN KEY (admin_command_id)
  REFERENCES moderation_appeal_admin_commands(command_id) ON DELETE RESTRICT;

CREATE TABLE moderation_action_corrections (
  correction_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES moderation_actions(action_id) ON DELETE RESTRICT,
  appeal_id uuid NOT NULL REFERENCES moderation_appeals(appeal_id) ON DELETE RESTRICT,
  admin_command_id uuid NOT NULL UNIQUE
    REFERENCES moderation_appeal_admin_commands(command_id) ON DELETE RESTRICT,
  decision moderation_appeal_decision NOT NULL,
  resulting_scope moderation_enforcement_scope,
  resulting_expires_at timestamptz,
  policy_reason_code text NOT NULL,
  policy_version text NOT NULL,
  corrected_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  corrected_at timestamptz NOT NULL,
  UNIQUE (action_id, appeal_id)
);

CREATE FUNCTION validate_moderation_appeal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action moderation_actions%ROWTYPE;
BEGIN
  SELECT * INTO action FROM moderation_actions
  WHERE action_id = NEW.action_id FOR UPDATE;
  IF NOT FOUND OR action.subject_user_id IS DISTINCT FROM NEW.appellant_user_id THEN
    RAISE EXCEPTION 'appealable moderation action required';
  END IF;
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.appellant_user_id
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'eligible appellant required'; END IF;
  NEW.submitted_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_appeal_validate
BEFORE INSERT ON moderation_appeals
FOR EACH ROW EXECUTE FUNCTION validate_moderation_appeal();

CREATE FUNCTION initialize_moderation_appeal_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO moderation_appeal_state_events (
    state_event_id, appeal_id, version, state, actor_user_id, recorded_at
  ) VALUES (
    NEW.appeal_id, NEW.appeal_id, 1, 'OPEN', NEW.appellant_user_id,
    NEW.submitted_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderation_appeal_initial_state
AFTER INSERT ON moderation_appeals
FOR EACH ROW EXECUTE FUNCTION initialize_moderation_appeal_state();

CREATE FUNCTION validate_moderation_appeal_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appeal moderation_appeals%ROWTYPE;
DECLARE latest moderation_appeal_state_events%ROWTYPE;
DECLARE command moderation_appeal_admin_commands%ROWTYPE;
BEGIN
  SELECT * INTO appeal FROM moderation_appeals
  WHERE appeal_id = NEW.appeal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'moderation appeal required'; END IF;
  SELECT * INTO latest FROM moderation_appeal_state_events event
  WHERE event.appeal_id = NEW.appeal_id
  ORDER BY event.version DESC LIMIT 1;
  IF latest.state_event_id IS NULL THEN
    IF pg_trigger_depth() < 2 OR NEW.version <> 1 OR NEW.state <> 'OPEN'
      OR NEW.actor_user_id IS DISTINCT FROM appeal.appellant_user_id
      OR NEW.state_event_id IS DISTINCT FROM appeal.appeal_id
      OR NEW.admin_command_id IS NOT NULL
      OR NEW.recorded_at IS DISTINCT FROM appeal.submitted_at THEN
      RAISE EXCEPTION 'exact initial moderation appeal state required';
    END IF;
  ELSE
    SELECT * INTO command FROM moderation_appeal_admin_commands
    WHERE command_id = NEW.admin_command_id;
    IF pg_trigger_depth() < 2 OR latest.state <> 'OPEN'
      OR command.command_id IS NULL
      OR command.appeal_id IS DISTINCT FROM NEW.appeal_id
      OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id
      OR command.expected_state IS DISTINCT FROM latest.state
      OR NEW.version <> latest.version + 1
      OR NEW.state::text IS DISTINCT FROM (
        CASE command.decision
          WHEN 'UPHOLD' THEN 'UPHELD'
          WHEN 'REDUCE' THEN 'REDUCED'
          ELSE 'REVERSED'
        END
      )
      OR NEW.state_event_id IS DISTINCT FROM command.command_id
      OR NEW.recorded_at IS DISTINCT FROM command.recorded_at THEN
      RAISE EXCEPTION 'appeal decision must derive from audited command';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_appeal_state_event_validate
BEFORE INSERT ON moderation_appeal_state_events
FOR EACH ROW EXECUTE FUNCTION validate_moderation_appeal_state_event();

CREATE FUNCTION validate_moderation_appeal_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state moderation_appeal_state;
DECLARE original moderation_actions%ROWTYPE;
DECLARE appellant_id uuid;
BEGIN
  SELECT event.state INTO current_state
  FROM moderation_appeal_state_events event
  WHERE event.appeal_id = NEW.appeal_id
  ORDER BY event.version DESC LIMIT 1 FOR UPDATE;
  IF current_state IS DISTINCT FROM NEW.expected_state OR current_state <> 'OPEN' THEN
    RAISE EXCEPTION 'stale moderation appeal state';
  END IF;
  IF NOT moderation_admin_session_is_recent(
      NEW.actor_privileged_session_hash, NEW.actor_user_id
    ) THEN
    RAISE EXCEPTION 'recent MFA-backed moderation capability required';
  END IF;
  SELECT action.* INTO original FROM moderation_appeals appeal
  JOIN moderation_actions action ON action.action_id = appeal.action_id
  WHERE appeal.appeal_id = NEW.appeal_id;
  SELECT appeal.appellant_user_id INTO appellant_id
  FROM moderation_appeals appeal WHERE appeal.appeal_id = NEW.appeal_id;
  IF NEW.actor_user_id = appellant_id THEN
    RAISE EXCEPTION 'appellant cannot decide own moderation appeal';
  END IF;
  IF NEW.decision = 'REDUCE' THEN
    IF original.enforcement_scope = 'CONTENT'
        OR NEW.reduced_scope = 'CONTENT'
        OR (
          NEW.reduced_scope IS DISTINCT FROM original.enforcement_scope
          AND original.enforcement_scope <> 'ACCOUNT'
        )
        OR (
          NEW.reduced_scope = 'ACCOUNT'
          AND original.enforcement_scope <> 'ACCOUNT'
        ) THEN
      RAISE EXCEPTION 'invalid reduced enforcement scope';
    END IF;
    IF NEW.reduced_expires_at IS NOT NULL
        AND NEW.reduced_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'future reduced restriction expiry required';
    END IF;
    IF NEW.reduced_scope = original.enforcement_scope
        AND (
          NEW.reduced_expires_at IS NULL
          OR (
            original.restriction_expires_at IS NOT NULL
            AND NEW.reduced_expires_at >= original.restriction_expires_at
          )
        ) THEN
      RAISE EXCEPTION 'appeal reduction must materially narrow enforcement';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_appeal_admin_command_validate
BEFORE INSERT ON moderation_appeal_admin_commands
FOR EACH ROW EXECUTE FUNCTION validate_moderation_appeal_admin_command();

CREATE FUNCTION apply_moderation_appeal_admin_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appeal moderation_appeals%ROWTYPE;
DECLARE next_version integer;
DECLARE resulting_state moderation_appeal_state;
BEGIN
  SELECT * INTO appeal FROM moderation_appeals WHERE appeal_id = NEW.appeal_id;
  resulting_state := CASE NEW.decision
    WHEN 'UPHOLD' THEN 'UPHELD'::moderation_appeal_state
    WHEN 'REDUCE' THEN 'REDUCED'::moderation_appeal_state
    ELSE 'REVERSED'::moderation_appeal_state
  END;
  SELECT coalesce(max(version), 0) + 1 INTO next_version
  FROM moderation_appeal_state_events WHERE appeal_id = NEW.appeal_id;
  INSERT INTO moderation_appeal_state_events (
    state_event_id, appeal_id, version, state, actor_user_id,
    admin_command_id, recorded_at
  ) VALUES (
    NEW.command_id, NEW.appeal_id, next_version, resulting_state,
    NEW.actor_user_id, NEW.command_id, NEW.recorded_at
  );
  INSERT INTO moderation_action_corrections (
    correction_id, action_id, appeal_id, admin_command_id, decision,
    resulting_scope, resulting_expires_at, policy_reason_code,
    policy_version, corrected_by_user_id, corrected_at
  ) VALUES (
    NEW.command_id, appeal.action_id, NEW.appeal_id, NEW.command_id,
    NEW.decision, NEW.reduced_scope, NEW.reduced_expires_at,
    NEW.policy_reason_code, NEW.policy_version, NEW.actor_user_id,
    NEW.recorded_at
  );
  PERFORM insert_exact_notification_outbox_event(
    'moderation:appeal:' || NEW.appeal_id::text || ':decision',
    'moderation.appeal.decided', NEW.recorded_at,
    'MODERATION_APPEAL', NEW.appeal_id::text,
    jsonb_build_object(
      'recipient_user_id', appeal.appellant_user_id::text,
      'appeal_id', NEW.appeal_id::text,
      'decision', NEW.decision::text
    ),
    'moderation.appeal.decided', NEW.command_id::text, NEW.recorded_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderation_appeal_admin_command_apply
AFTER INSERT ON moderation_appeal_admin_commands
FOR EACH ROW EXECUTE FUNCTION apply_moderation_appeal_admin_command();

CREATE FUNCTION require_moderation_appeal_command_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events audit
    WHERE audit.event_id = NEW.audit_event_id
      AND audit.correlation_id = NEW.command_id
      AND audit.category = 'PRIVILEGED_COMMAND'
      AND audit.action_type = CASE NEW.decision
        WHEN 'UPHOLD' THEN 'admin.moderation.appeal_upheld'
        WHEN 'REDUCE' THEN 'admin.moderation.appeal_reduced'
        ELSE 'admin.moderation.appeal_reversed'
      END
      AND audit.actor_kind = 'AUTHENTICATED_USER'
      AND audit.actor_user_id = NEW.actor_user_id
      AND audit.actor_capability = 'admin.reviews.moderate'
      AND audit.target_type = 'MODERATION_APPEAL'
      AND audit.target_id = NEW.appeal_id::text
      AND audit.reason = NEW.reason
  ) THEN
    RAISE EXCEPTION 'matching immutable moderation appeal audit event required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER moderation_appeal_command_audit_required
AFTER INSERT ON moderation_appeal_admin_commands DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_moderation_appeal_command_audit();

CREATE VIEW current_moderation_appeal_states
WITH (security_invoker = true)
AS
SELECT appeal.appeal_id, appeal.action_id, appeal.appellant_user_id,
  appeal.explanation, appeal.evidence_reference_type,
  appeal.evidence_reference_id, appeal.submitted_at,
  latest.state, latest.version AS state_version,
  latest.recorded_at AS state_recorded_at
FROM moderation_appeals appeal
JOIN LATERAL (
  SELECT event.state, event.version, event.recorded_at
  FROM moderation_appeal_state_events event
  WHERE event.appeal_id = appeal.appeal_id
  ORDER BY event.version DESC LIMIT 1
) latest ON true;

CREATE VIEW current_moderation_actions
WITH (security_invoker = true)
AS
SELECT action.action_id, action.report_id, action.action, action.source,
  action.target_type, action.target_id, action.subject_user_id,
  CASE WHEN correction.decision = 'REDUCE'
    THEN correction.resulting_scope ELSE action.enforcement_scope END
    AS enforcement_scope,
  CASE WHEN correction.decision = 'REDUCE'
    THEN correction.resulting_expires_at ELSE action.restriction_expires_at END
    AS restriction_expires_at,
  action.policy_category,
  coalesce(correction.policy_reason_code, action.policy_reason_code)
    AS policy_reason_code,
  coalesce(correction.policy_version, action.policy_version) AS policy_version,
  action.user_facing_reason, action.prior_state, action.applied_by_user_id,
  action.applied_at, correction.decision AS correction_decision,
  correction.corrected_at,
  correction.decision IS DISTINCT FROM 'REVERSE'
    AND (
      CASE WHEN correction.decision = 'REDUCE'
        THEN correction.resulting_expires_at ELSE action.restriction_expires_at END
      IS NULL
      OR CASE WHEN correction.decision = 'REDUCE'
        THEN correction.resulting_expires_at ELSE action.restriction_expires_at END
        > clock_timestamp()
    ) AS active
FROM moderation_actions action
LEFT JOIN LATERAL (
  SELECT item.* FROM moderation_action_corrections item
  WHERE item.action_id = action.action_id
  ORDER BY item.corrected_at DESC, item.correction_id DESC LIMIT 1
) correction ON true;

CREATE VIEW current_moderation_hidden_targets
WITH (security_invoker = true)
AS
SELECT action.action_id, action.target_type, action.target_id,
  action.subject_user_id, action.applied_at
FROM current_moderation_actions action
WHERE action.action = 'HIDE_CONTENT' AND action.active;

CREATE VIEW current_moderation_review_evidence_exclusions
WITH (security_invoker = true)
AS
SELECT action.action_id, action.target_type, action.target_id,
  action.subject_user_id, action.applied_at
FROM current_moderation_actions action
WHERE action.action = 'EXCLUDE_REVIEW_EVIDENCE' AND action.active;

CREATE VIEW current_moderation_user_restrictions
WITH (security_invoker = true)
AS
SELECT action.action_id, action.subject_user_id, action.enforcement_scope,
  action.restriction_expires_at, action.policy_category,
  action.user_facing_reason, action.applied_at
FROM current_moderation_actions action
WHERE action.action IN (
    'APPLY_FEATURE_RESTRICTION', 'APPLY_TEMPORARY_SUSPENSION',
    'APPLY_INDEFINITE_SUSPENSION'
  ) AND action.active;

-- A D24 profile hide is independent from the owner's PUBLIC/HIDDEN choice and
-- from the older publication approval history. Removing or reversing the
-- action therefore restores the last legitimate owner preference automatically.
CREATE OR REPLACE VIEW current_craftsman_profile_publications AS
WITH current_revision AS (
  SELECT DISTINCT ON (revision.craftsman_profile_id) revision.*
  FROM craftsman_profile_publication_revisions revision
  ORDER BY revision.craftsman_profile_id, revision.revision DESC
)
SELECT
  profile.id AS craftsman_profile_id,
  profile.owner_user_id,
  COALESCE(revision.revision, 0) AS revision,
  COALESCE(revision.review_state, 'DRAFT')::craftsman_profile_review_state
    AS review_state,
  COALESCE(revision.owner_visibility, 'HIDDEN')::craftsman_profile_owner_visibility
    AS owner_visibility,
  COALESCE(revision.moderation_state, 'ALLOWED')::craftsman_profile_moderation_state
    AS moderation_state,
  revision.approved_by_user_id,
  revision.approved_at,
  revision.rejection_reason_code,
  revision.rejection_user_facing_reason,
  revision.rejected_by_user_id,
  revision.rejected_at,
  revision.moderation_reason_category,
  revision.moderation_reason_code,
  revision.moderation_policy_version,
  revision.moderated_by_user_id,
  revision.moderated_at,
  revision.identity_review_reason_code,
  revision.identity_review_rule_reference,
  COALESCE(
    craftsman_profile_missing_publication_requirements(profile.id),
    ARRAY['VALID_IDENTITY', 'ABOUT', 'ACTIVE_PROFESSION_WITH_DECLARED_LEVEL',
      'BASE_MUNICIPALITY', 'NORMAL_RADIUS']::text[]
  ) AS missing_requirements,
  COALESCE((
    owner.account_state = 'ACTIVE'
    AND revision.review_state = 'APPROVED'
    AND revision.owner_visibility = 'PUBLIC'
    AND revision.moderation_state = 'ALLOWED'
    AND cardinality(craftsman_profile_missing_publication_requirements(profile.id)) = 0
    AND NOT EXISTS (
      SELECT 1 FROM current_moderation_hidden_targets hidden
      WHERE hidden.target_type = 'CRAFTSMAN_PROFILE'
        AND hidden.target_id = profile.id
    )
  ), false) AS effectively_public,
  revision.changed_at
FROM craftsman_profiles profile
JOIN users owner ON owner.id = profile.owner_user_id
LEFT JOIN current_revision revision ON revision.craftsman_profile_id = profile.id;

CREATE OR REPLACE VIEW current_moderation_report_states
WITH (security_invoker = true)
AS
SELECT report.report_id, report.reporter_user_id,
  report.target_type, report.target_id, report.reason, report.details,
  report.reported_at, latest.state, latest.version AS state_version,
  latest.recorded_at AS state_recorded_at,
  report.evidence_reference_type, report.evidence_reference_id
FROM moderation_reports report
JOIN LATERAL (
  SELECT event.state, event.version, event.recorded_at
  FROM moderation_report_state_events event
  WHERE event.report_id = report.report_id
  ORDER BY event.version DESC LIMIT 1
) latest ON true;

-- Preserve the older conversation intake API while routing every new claim
-- into the same moderation queue. No message body is copied into the report.
CREATE FUNCTION mirror_conversation_report_to_moderation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO moderation_reports (
    report_id, reporter_user_id, target_type, target_id, reason, details,
    evidence_reference_type, evidence_reference_id, reported_at
  ) VALUES (
    NEW.id, NEW.reporter_user_id,
    CASE WHEN NEW.message_id IS NULL
      THEN 'CONVERSATION'::moderation_report_target_type
      ELSE 'MESSAGE'::moderation_report_target_type END,
    coalesce(NEW.message_id, NEW.conversation_id),
    CASE NEW.reason
      WHEN 'ABUSE' THEN 'HARASSMENT_ABUSE'::moderation_report_reason
      WHEN 'CONTACT_CIRCUMVENTION' THEN 'PLATFORM_BYPASS_ATTEMPT'::moderation_report_reason
      WHEN 'FRAUD_OR_SCAM' THEN 'SUSPICIOUS_PAYMENT_SCAM'::moderation_report_reason
      WHEN 'THREAT' THEN 'THREATS'::moderation_report_reason
      ELSE 'OTHER'::moderation_report_reason
    END,
    NULL, 'CONVERSATION', NEW.conversation_id, NEW.created_at
  ) ON CONFLICT (report_id) DO NOTHING;
  RETURN NULL;
END;
$$;
CREATE TRIGGER conversation_report_moderation_mirror
AFTER INSERT ON conversation_reports
FOR EACH ROW EXECUTE FUNCTION mirror_conversation_report_to_moderation();

INSERT INTO moderation_reports (
  report_id, reporter_user_id, target_type, target_id, reason, details,
  evidence_reference_type, evidence_reference_id, reported_at
)
SELECT report.id, report.reporter_user_id,
  CASE WHEN report.message_id IS NULL
    THEN 'CONVERSATION'::moderation_report_target_type
    ELSE 'MESSAGE'::moderation_report_target_type END,
  coalesce(report.message_id, report.conversation_id),
  CASE report.reason
    WHEN 'ABUSE' THEN 'HARASSMENT_ABUSE'::moderation_report_reason
    WHEN 'CONTACT_CIRCUMVENTION' THEN 'PLATFORM_BYPASS_ATTEMPT'::moderation_report_reason
    WHEN 'FRAUD_OR_SCAM' THEN 'SUSPICIOUS_PAYMENT_SCAM'::moderation_report_reason
    WHEN 'THREAT' THEN 'THREATS'::moderation_report_reason
    ELSE 'OTHER'::moderation_report_reason
  END,
  NULL, 'CONVERSATION', report.conversation_id, report.created_at
FROM conversation_reports report
ON CONFLICT (report_id) DO NOTHING;

-- Review text visibility and evidence validity are distinct. Hiding text keeps
-- ratings; excluding evidence removes the entire review from reputation.
CREATE OR REPLACE VIEW current_unlocked_provider_main_review_scores
WITH (security_invoker = true)
AS
SELECT review.revision_id, review.target_profile_id AS craftsman_profile_id,
  review.accepted_profession_code AS profession_code,
  round(avg((rating.value #>> '{}')::numeric), 2) AS review_score
FROM current_unlocked_job_main_reviews review
CROSS JOIN LATERAL jsonb_each(review.ratings) rating
WHERE review.direction = 'CUSTOMER_TO_PROVIDER'
  AND review.target_kind = 'CRAFTSMAN_PROFILE'
  AND jsonb_typeof(rating.value) = 'number'
  AND NOT EXISTS (
    SELECT 1 FROM current_moderation_review_evidence_exclusions exclusion
    WHERE exclusion.target_type = 'MAIN_REVIEW'
      AND exclusion.target_id = review.revision_id
  )
GROUP BY review.revision_id, review.target_profile_id,
  review.accepted_profession_code;

CREATE OR REPLACE VIEW current_public_portfolio_projects AS
SELECT project.id AS portfolio_project_id,
  project.craftsman_profile_id,
  project.revision AS project_revision,
  publication.revision AS publication_revision,
  project.provenance_kind,
  'UNVERIFIED'::text AS evidence_status,
  project.title, project.short_description, project.contribution,
  project.materials_and_technologies, project.problem, project.solution,
  project.duration_value, project.duration_unit,
  project.indicative_price_min_cents, project.indicative_price_max_cents,
  project.municipality_code, project.district_code
FROM portfolio_project_publications publication
JOIN portfolio_project_publication_revisions revision
  ON revision.portfolio_project_id = publication.portfolio_project_id
  AND revision.revision = publication.revision
JOIN portfolio_projects project
  ON project.id = publication.portfolio_project_id
JOIN current_craftsman_profile_publications profile_publication
  ON profile_publication.craftsman_profile_id = publication.craftsman_profile_id
WHERE publication.state = 'PUBLIC'
  AND revision.state = 'PUBLIC'
  AND profile_publication.effectively_public
  AND project.record_state = 'DRAFT'
  AND project.provenance_kind = 'SELF_DECLARED'
  AND project.revision = revision.project_revision
  AND NOT EXISTS (
    SELECT 1 FROM current_moderation_hidden_targets hidden
    WHERE hidden.target_type = 'PORTFOLIO_PROJECT'
      AND hidden.target_id = project.id
  )
  AND EXISTS (
    SELECT 1
    FROM portfolio_project_publication_items item
    JOIN media_asset_storage_objects object
      ON object.id = item.public_object_id
    WHERE item.revision_event_id = revision.event_id
      AND object.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM current_moderation_hidden_targets hidden
        WHERE hidden.target_type = 'MEDIA_ASSET'
          AND hidden.target_id = item.media_asset_id
      )
  );

CREATE OR REPLACE VIEW current_public_portfolio_project_photos AS
SELECT project.portfolio_project_id, project.craftsman_profile_id,
  project.publication_revision, item.media_asset_id, item.phase,
  item.display_order, item.canonical_width, item.canonical_height
FROM current_public_portfolio_projects project
JOIN portfolio_project_publication_revisions revision
  ON revision.portfolio_project_id = project.portfolio_project_id
  AND revision.revision = project.publication_revision
JOIN portfolio_project_publication_items item
  ON item.revision_event_id = revision.event_id
JOIN media_asset_storage_objects object
  ON object.id = item.public_object_id
WHERE object.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM current_moderation_hidden_targets hidden
    WHERE hidden.target_type = 'MEDIA_ASSET'
      AND hidden.target_id = item.media_asset_id
  );

CREATE INDEX moderation_reports_queue_idx
  ON moderation_reports (reported_at, report_id);
CREATE INDEX moderation_actions_target_idx
  ON moderation_actions (target_type, target_id, applied_at DESC);
CREATE INDEX moderation_actions_subject_idx
  ON moderation_actions (subject_user_id, applied_at DESC);
CREATE INDEX moderation_appeals_queue_idx
  ON moderation_appeals (submitted_at, appeal_id);
CREATE INDEX moderation_risk_flags_target_idx
  ON moderation_risk_flags (target_type, target_id, created_at DESC);

CREATE TRIGGER moderation_admin_commands_immutable
BEFORE UPDATE OR DELETE ON moderation_admin_commands
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_actions_immutable
BEFORE UPDATE OR DELETE ON moderation_actions
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_risk_flags_immutable
BEFORE UPDATE OR DELETE ON moderation_risk_flags
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_appeals_immutable
BEFORE UPDATE OR DELETE ON moderation_appeals
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_appeal_state_events_immutable
BEFORE UPDATE OR DELETE ON moderation_appeal_state_events
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_appeal_admin_commands_immutable
BEFORE UPDATE OR DELETE ON moderation_appeal_admin_commands
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_action_corrections_immutable
BEFORE UPDATE OR DELETE ON moderation_action_corrections
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();

COMMENT ON TABLE moderation_admin_commands IS
  'Named recent-MFA moderation decisions; report count is never a verdict and no generic status setter exists.';
COMMENT ON TABLE moderation_actions IS
  'History-preserving policy effects with stable policy provenance, prior state and a safe user notice.';
COMMENT ON TABLE moderation_appeals IS
  'Separate user reconsideration record; submission never lifts an active protective restriction.';
COMMENT ON TABLE moderation_action_corrections IS
  'Audited uphold/reduce/reverse outcome; original action history is never rewritten.';
COMMENT ON TABLE moderation_risk_flags IS
  'Private provenance-bearing investigation signals, never public reputation or automatic verdicts.';
COMMENT ON VIEW current_moderation_hidden_targets IS
  'Reversible current visibility restrictions; underlying immutable content remains retained.';
COMMENT ON VIEW current_moderation_user_restrictions IS
  'Capability-ready active enforcement projection for D26 authorization integration.';
