-- R4-020: one public rated-party response and report intake are separate,
-- append-only records. A report is never an automatic moderation verdict.
CREATE TABLE job_main_review_responses (
  response_id uuid PRIMARY KEY,
  review_revision_id uuid NOT NULL UNIQUE
    REFERENCES job_main_review_events(event_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  direction job_main_review_direction NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  create_command_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, direction),
  CONSTRAINT job_main_review_response_public_direction
    CHECK (direction = 'CUSTOMER_TO_PROVIDER')
);

CREATE FUNCTION validate_job_main_review_response()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review current_unlocked_job_main_reviews%ROWTYPE;
  existing job_main_review_responses%ROWTYPE;
  owner_id uuid;
BEGIN
  SELECT * INTO existing FROM job_main_review_responses
  WHERE create_command_id = NEW.create_command_id;
  IF FOUND THEN
    IF existing.response_id IS NOT DISTINCT FROM NEW.response_id
      AND existing.review_revision_id IS NOT DISTINCT FROM NEW.review_revision_id
      AND existing.job_id IS NOT DISTINCT FROM NEW.job_id
      AND existing.direction IS NOT DISTINCT FROM NEW.direction
      AND existing.author_user_id IS NOT DISTINCT FROM NEW.author_user_id THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'review response command identifier reuse conflict';
  END IF;

  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT * INTO review FROM current_unlocked_job_main_reviews
  WHERE revision_id = NEW.review_revision_id
    AND job_id = NEW.job_id
    AND direction = NEW.direction
    AND direction = 'CUSTOMER_TO_PROVIDER'
    AND target_kind = 'CRAFTSMAN_PROFILE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unlocked public review required';
  END IF;

  SELECT profile.owner_user_id INTO owner_id
  FROM craftsman_profiles profile
  JOIN users actor ON actor.id = profile.owner_user_id
    AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials credential ON credential.user_id = actor.id
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  WHERE profile.id = review.target_profile_id
  FOR SHARE OF profile, actor, credential;
  IF owner_id IS NULL OR NEW.author_user_id IS DISTINCT FROM owner_id
    OR NEW.author_user_id IS NOT DISTINCT FROM review.actor_user_id THEN
    RAISE EXCEPTION 'reviewed profile owner required';
  END IF;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_main_review_response_validate
BEFORE INSERT ON job_main_review_responses
FOR EACH ROW EXECUTE FUNCTION validate_job_main_review_response();

CREATE TABLE job_main_review_response_events (
  event_id uuid PRIMARY KEY,
  response_id uuid NOT NULL
    REFERENCES job_main_review_responses(response_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (response_id, version)
);

CREATE FUNCTION validate_job_main_review_response_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  response job_main_review_responses%ROWTYPE;
  prior job_main_review_response_events%ROWTYPE;
  first_at timestamptz;
  latest_version integer;
  now_at timestamptz;
BEGIN
  SELECT * INTO prior FROM job_main_review_response_events
  WHERE event_id = NEW.event_id;
  IF FOUND THEN
    IF prior.response_id IS NOT DISTINCT FROM NEW.response_id
      AND prior.version IS NOT DISTINCT FROM NEW.version
      AND prior.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND prior.body IS NOT DISTINCT FROM NEW.body THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'review response event identifier reuse conflict';
  END IF;

  SELECT * INTO response FROM job_main_review_responses
  WHERE response_id = NEW.response_id FOR UPDATE;
  IF NOT FOUND OR NEW.actor_user_id IS DISTINCT FROM response.author_user_id THEN
    RAISE EXCEPTION 'review response author required';
  END IF;
  PERFORM 1 FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN RAISE EXCEPTION 'active verified response author required'; END IF;
  IF NEW.body <> btrim(NEW.body) OR length(NEW.body) < 1
    OR length(NEW.body) > 2000 OR NEW.body ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid review response body';
  END IF;

  SELECT min(recorded_at), max(version) INTO first_at, latest_version
  FROM job_main_review_response_events WHERE response_id = NEW.response_id;
  now_at := clock_timestamp();
  IF first_at IS NULL THEN
    IF NEW.version <> 1 OR NEW.event_id IS DISTINCT FROM response.create_command_id THEN
      RAISE EXCEPTION 'first review response revision required';
    END IF;
  ELSIF NEW.version <> latest_version + 1
    OR now_at >= first_at + interval '60 minutes' THEN
    RAISE EXCEPTION 'review response edit window closed or stale';
  END IF;
  NEW.recorded_at := now_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_main_review_response_event_validate
BEFORE INSERT ON job_main_review_response_events
FOR EACH ROW EXECUTE FUNCTION validate_job_main_review_response_event();

CREATE FUNCTION reject_job_main_review_response_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job main review response history is immutable'; END;
$$;
CREATE TRIGGER job_main_review_response_immutable
BEFORE UPDATE OR DELETE ON job_main_review_responses
FOR EACH ROW EXECUTE FUNCTION reject_job_main_review_response_mutation();
CREATE TRIGGER job_main_review_response_event_immutable
BEFORE UPDATE OR DELETE ON job_main_review_response_events
FOR EACH ROW EXECUTE FUNCTION reject_job_main_review_response_mutation();

CREATE VIEW current_job_main_review_responses
WITH (security_invoker = true)
AS
WITH latest AS (
  SELECT DISTINCT ON (response_id) response_id,
    event_id AS revision_id, version, body, recorded_at AS revised_at
  FROM job_main_review_response_events
  ORDER BY response_id, version DESC
), firsts AS (
  SELECT response_id, recorded_at AS responded_at
  FROM job_main_review_response_events WHERE version = 1
)
SELECT response.response_id, response.review_revision_id,
  response.job_id, response.direction, response.author_user_id,
  firsts.responded_at, latest.revision_id, latest.version,
  latest.body, latest.revised_at,
  firsts.responded_at + interval '60 minutes' AS locked_at
FROM job_main_review_responses response
JOIN firsts ON firsts.response_id = response.response_id
JOIN latest ON latest.response_id = response.response_id;

CREATE TYPE moderation_report_target_type AS ENUM (
  'MAIN_REVIEW', 'REVIEW_RESPONSE', 'SUPERVISOR_EVALUATION'
);
CREATE TYPE moderation_report_reason AS ENUM (
  'PERSONAL_DATA_PRIVACY', 'HARASSMENT_ABUSE',
  'EXTORTION_RETALIATION', 'IRRELEVANT_CONTENT',
  'SUSPECTED_FRAUD_FAKE_REVIEW', 'OTHER'
);
CREATE TYPE moderation_report_state AS ENUM (
  'OPEN', 'UNDER_REVIEW', 'ACTIONED', 'NO_VIOLATION', 'CLOSED'
);
CREATE TYPE moderation_report_state_source AS ENUM ('REPORTER', 'ADMIN');

CREATE TABLE moderation_reports (
  report_id uuid PRIMARY KEY,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_type moderation_report_target_type NOT NULL,
  target_id uuid NOT NULL,
  reason moderation_report_reason NOT NULL,
  details text,
  reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (reporter_user_id, target_type, target_id),
  CONSTRAINT moderation_report_details_safe CHECK (
    details IS NULL OR (
      details = btrim(details) AND length(details) BETWEEN 1 AND 1000
      AND details !~ '[[:cntrl:]]'
    )
  )
);

CREATE TABLE moderation_report_state_events (
  state_event_id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES moderation_reports(report_id)
    ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state moderation_report_state NOT NULL,
  source moderation_report_state_source NOT NULL,
  policy_reason_code text,
  private_admin_note text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (report_id, version),
  CONSTRAINT moderation_report_policy_reason_safe CHECK (
    policy_reason_code IS NULL OR policy_reason_code ~ '^[A-Z][A-Z0-9_]{2,79}$'
  ),
  CONSTRAINT moderation_report_private_note_safe CHECK (
    private_admin_note IS NULL OR (
      private_admin_note = btrim(private_admin_note)
      AND length(private_admin_note) BETWEEN 1 AND 1000
      AND private_admin_note !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT moderation_report_state_origin CHECK (
    (
      version = 1 AND state = 'OPEN' AND source = 'REPORTER'
      AND policy_reason_code IS NULL AND private_admin_note IS NULL
    ) OR (
      version > 1 AND source = 'ADMIN' AND policy_reason_code IS NOT NULL
    )
  )
);

CREATE FUNCTION validate_moderation_report()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior moderation_reports%ROWTYPE;
  target_exists boolean;
BEGIN
  SELECT * INTO prior FROM moderation_reports WHERE report_id = NEW.report_id;
  IF FOUND THEN
    IF prior.reporter_user_id IS NOT DISTINCT FROM NEW.reporter_user_id
      AND prior.target_type IS NOT DISTINCT FROM NEW.target_type
      AND prior.target_id IS NOT DISTINCT FROM NEW.target_id
      AND prior.reason IS NOT DISTINCT FROM NEW.reason
      AND prior.details IS NOT DISTINCT FROM NEW.details THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'moderation report identifier reuse conflict';
  END IF;

  PERFORM 1 FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.reporter_user_id AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN RAISE EXCEPTION 'active verified reporter required'; END IF;

  IF NEW.target_type = 'MAIN_REVIEW' THEN
    SELECT EXISTS (
      SELECT 1 FROM current_unlocked_job_main_reviews review
      WHERE review.revision_id = NEW.target_id
        AND review.direction = 'CUSTOMER_TO_PROVIDER'
        AND review.target_kind = 'CRAFTSMAN_PROFILE'
    ) INTO target_exists;
  ELSIF NEW.target_type = 'REVIEW_RESPONSE' THEN
    SELECT EXISTS (
      SELECT 1 FROM current_job_main_review_responses response
      JOIN current_unlocked_job_main_reviews review
        ON review.revision_id = response.review_revision_id
      WHERE response.response_id = NEW.target_id
        AND review.direction = 'CUSTOMER_TO_PROVIDER'
        AND review.target_kind = 'CRAFTSMAN_PROFILE'
    ) INTO target_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM job_supervisor_evaluations evaluation
      JOIN job_participants participant
        ON participant.id = evaluation.target_participant_id
      JOIN craftsman_profiles profile
        ON profile.id = participant.craftsman_profile_id
      WHERE evaluation.evaluation_id = NEW.target_id
        AND profile.owner_user_id = NEW.reporter_user_id
    ) INTO target_exists;
  END IF;
  IF target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reportable visible target required';
  END IF;
  NEW.reported_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_report_validate
BEFORE INSERT ON moderation_reports
FOR EACH ROW EXECUTE FUNCTION validate_moderation_report();

CREATE FUNCTION initialize_moderation_report_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO moderation_report_state_events (
    state_event_id, report_id, version, actor_user_id, state, source
  ) VALUES (
    NEW.report_id, NEW.report_id, 1, NEW.reporter_user_id, 'OPEN', 'REPORTER'
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER moderation_report_initial_state
AFTER INSERT ON moderation_reports
FOR EACH ROW EXECUTE FUNCTION initialize_moderation_report_state();

CREATE FUNCTION validate_moderation_report_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  report moderation_reports%ROWTYPE;
  prior moderation_report_state_events%ROWTYPE;
  latest_version integer;
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
      AND prior.private_admin_note IS NOT DISTINCT FROM NEW.private_admin_note THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'report state event identifier reuse conflict';
  END IF;
  SELECT * INTO report FROM moderation_reports
  WHERE report_id = NEW.report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'moderation report required'; END IF;
  SELECT max(version) INTO latest_version FROM moderation_report_state_events
  WHERE report_id = NEW.report_id;
  IF latest_version IS NULL THEN
    IF NEW.version <> 1 OR NEW.state <> 'OPEN' OR NEW.source <> 'REPORTER'
      OR NEW.actor_user_id IS DISTINCT FROM report.reporter_user_id
      OR NEW.state_event_id IS DISTINCT FROM report.report_id THEN
      RAISE EXCEPTION 'exact initial report state required';
    END IF;
  ELSIF NEW.version <> latest_version + 1 OR NEW.source <> 'ADMIN' THEN
    RAISE EXCEPTION 'sequential admin report state required';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_report_state_event_validate
BEFORE INSERT ON moderation_report_state_events
FOR EACH ROW EXECUTE FUNCTION validate_moderation_report_state_event();

CREATE FUNCTION reject_moderation_report_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'moderation report history is immutable'; END;
$$;
CREATE TRIGGER moderation_report_immutable
BEFORE UPDATE OR DELETE ON moderation_reports
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();
CREATE TRIGGER moderation_report_state_event_immutable
BEFORE UPDATE OR DELETE ON moderation_report_state_events
FOR EACH ROW EXECUTE FUNCTION reject_moderation_report_mutation();

CREATE VIEW current_moderation_report_states
WITH (security_invoker = true)
AS
SELECT report.report_id, report.reporter_user_id,
  report.target_type, report.target_id, report.reason, report.details,
  report.reported_at, latest.state, latest.version AS state_version,
  latest.recorded_at AS state_recorded_at
FROM moderation_reports report
JOIN LATERAL (
  SELECT event.state, event.version, event.recorded_at
  FROM moderation_report_state_events event
  WHERE event.report_id = report.report_id
  ORDER BY event.version DESC LIMIT 1
) latest ON true;

COMMENT ON TABLE job_main_review_responses IS
  'One stable rated-party response per unlocked public customer review; original rating values remain unchanged.';
COMMENT ON TABLE job_main_review_response_events IS
  'Append-only response revisions with a short edit window and no threaded continuation.';
COMMENT ON TABLE moderation_reports IS
  'Independent immutable user reports. Creation is a claim only and has no automatic visibility, reputation or account effect.';
COMMENT ON TABLE moderation_report_state_events IS
  'Append-only report workflow states; R4-023 adds capability/MFA-gated admin commands and appeal actions.';
