-- Lightweight execution records are not a construction diary or commercial
-- amendment. Historical records remain readable after cancellation.
CREATE TYPE job_issue_kind AS ENUM ('PROBLEM', 'DELAY', 'WAITING');

CREATE TABLE job_progress_updates (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (
    body = btrim(body) AND length(body) BETWEEN 1 AND 2000
    AND body !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, id)
);
CREATE INDEX job_progress_updates_page_idx
  ON job_progress_updates (job_id, created_at DESC, id DESC);

CREATE TABLE job_progress_acknowledgements (
  id uuid PRIMARY KEY,
  progress_update_id uuid NOT NULL REFERENCES job_progress_updates(id)
    ON DELETE RESTRICT,
  customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (progress_update_id, customer_user_id)
);

CREATE TABLE job_issues (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role text NOT NULL CHECK (
    author_role IN ('CUSTOMER', 'PRIMARY_PROVIDER')
  ),
  kind job_issue_kind NOT NULL,
  body text NOT NULL CHECK (
    body = btrim(body) AND length(body) BETWEEN 8 AND 2000
    AND body !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, id)
);
CREATE INDEX job_issues_page_idx
  ON job_issues (job_id, created_at DESC, id DESC);

CREATE TABLE job_issue_comments (
  id uuid PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES job_issues(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role text NOT NULL CHECK (
    author_role IN ('CUSTOMER', 'PRIMARY_PROVIDER')
  ),
  body text NOT NULL CHECK (
    body = btrim(body) AND length(body) BETWEEN 1 AND 2000
    AND body !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX job_issue_comments_page_idx
  ON job_issue_comments (issue_id, created_at DESC, id DESC);

CREATE FUNCTION validate_job_operational_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  target_author_id uuid;
  target_role text;
  customer_id uuid;
  provider_id uuid;
  current_state job_state;
BEGIN
  IF TG_TABLE_NAME = 'job_progress_updates' THEN
    target_job_id := NEW.job_id;
    target_author_id := NEW.author_user_id;
    target_role := 'PRIMARY_PROVIDER';
  ELSIF TG_TABLE_NAME = 'job_issues' THEN
    target_job_id := NEW.job_id;
    target_author_id := NEW.author_user_id;
    target_role := NEW.author_role;
  ELSIF TG_TABLE_NAME = 'job_issue_comments' THEN
    SELECT issue.job_id INTO target_job_id FROM job_issues issue
      WHERE issue.id = NEW.issue_id;
    target_author_id := NEW.author_user_id;
    target_role := NEW.author_role;
  ELSE
    SELECT progress.job_id INTO target_job_id FROM job_progress_updates progress
      WHERE progress.id = NEW.progress_update_id;
    target_author_id := NEW.customer_user_id;
    target_role := 'CUSTOMER';
  END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirmed Job required'; END IF;
  -- Job-then-command lock order matches the repository path.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51010));
  IF (TG_TABLE_NAME <> 'job_progress_updates'
        AND EXISTS (SELECT 1 FROM job_progress_updates WHERE id = NEW.id))
    OR (TG_TABLE_NAME <> 'job_progress_acknowledgements'
        AND EXISTS (SELECT 1 FROM job_progress_acknowledgements WHERE id = NEW.id))
    OR (TG_TABLE_NAME <> 'job_issues'
        AND EXISTS (SELECT 1 FROM job_issues WHERE id = NEW.id))
    OR (TG_TABLE_NAME <> 'job_issue_comments'
        AND EXISTS (SELECT 1 FROM job_issue_comments WHERE id = NEW.id)) THEN
    RAISE EXCEPTION 'Job operational command ID collision';
  END IF;
  PERFORM 1 FROM users WHERE id = target_author_id FOR SHARE;
  PERFORM 1 FROM auth_credentials
    WHERE user_id = target_author_id FOR SHARE;
  SELECT customer.owner_user_id, provider.owner_user_id, state.state
    INTO customer_id, provider_id, current_state
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN users actor ON actor.id = target_author_id
  JOIN auth_credentials credentials ON credentials.user_id = actor.id
  WHERE job.id = target_job_id
    AND actor.account_state = 'ACTIVE'
    AND credentials.email_verified_at IS NOT NULL
    AND credentials.phone_verified_at IS NOT NULL;
  IF (target_role = 'CUSTOMER' AND target_author_id IS DISTINCT FROM customer_id)
    OR (target_role = 'PRIMARY_PROVIDER'
      AND target_author_id IS DISTINCT FROM provider_id)
    OR target_role NOT IN ('CUSTOMER', 'PRIMARY_PROVIDER') THEN
    RAISE EXCEPTION 'active primary Job party required';
  END IF;
  IF current_state NOT IN ('CONFIRMED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'Job execution is closed';
  END IF;
  IF TG_TABLE_NAME = 'job_progress_acknowledgements' THEN
    IF EXISTS (
      SELECT 1 FROM job_progress_acknowledgements acknowledgement
      WHERE acknowledgement.progress_update_id = NEW.progress_update_id
        AND acknowledgement.customer_user_id = NEW.customer_user_id
    ) THEN
      RAISE EXCEPTION 'progress already acknowledged';
    END IF;
    NEW.acknowledged_at := clock_timestamp();
  ELSE
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_job_operational_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job operational history is immutable';
END;
$$;

CREATE TRIGGER job_progress_insert_validate BEFORE INSERT ON job_progress_updates
  FOR EACH ROW EXECUTE FUNCTION validate_job_operational_insert();
CREATE TRIGGER job_progress_ack_insert_validate BEFORE INSERT ON job_progress_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION validate_job_operational_insert();
CREATE TRIGGER job_issue_insert_validate BEFORE INSERT ON job_issues
  FOR EACH ROW EXECUTE FUNCTION validate_job_operational_insert();
CREATE TRIGGER job_issue_comment_insert_validate BEFORE INSERT ON job_issue_comments
  FOR EACH ROW EXECUTE FUNCTION validate_job_operational_insert();

CREATE TRIGGER job_progress_immutable BEFORE UPDATE OR DELETE ON job_progress_updates
  FOR EACH ROW EXECUTE FUNCTION reject_job_operational_mutation();
CREATE TRIGGER job_progress_ack_immutable BEFORE UPDATE OR DELETE ON job_progress_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION reject_job_operational_mutation();
CREATE TRIGGER job_issue_immutable BEFORE UPDATE OR DELETE ON job_issues
  FOR EACH ROW EXECUTE FUNCTION reject_job_operational_mutation();
CREATE TRIGGER job_issue_comment_immutable BEFORE UPDATE OR DELETE ON job_issue_comments
  FOR EACH ROW EXECUTE FUNCTION reject_job_operational_mutation();

CREATE FUNCTION notify_job_progress_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
BEGIN
  SELECT customer.owner_user_id INTO recipient_id
  FROM jobs job JOIN customer_profiles customer
    ON customer.id = job.customer_profile_id WHERE job.id = NEW.job_id;
  IF recipient_id IS NULL THEN
    RAISE EXCEPTION 'progress notification recipient missing';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job.progress.' || NEW.id::text, 'job.progress.created', NEW.created_at,
    'JOB', NEW.job_id::text,
    jsonb_build_object('recipient_user_id', recipient_id::text,
      'progress_update_id', NEW.id::text),
    'job.progress', NEW.id::text, NEW.created_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_progress_notify AFTER INSERT ON job_progress_updates
  FOR EACH ROW EXECUTE FUNCTION notify_job_progress_update();

CREATE FUNCTION notify_job_issue()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
BEGIN
  SELECT CASE WHEN NEW.author_role = 'CUSTOMER'
      THEN provider.owner_user_id ELSE customer.owner_user_id END
    INTO recipient_id
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  WHERE job.id = NEW.job_id;
  IF recipient_id IS NULL THEN
    RAISE EXCEPTION 'Issue notification recipient missing';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job.issue.' || NEW.id::text, 'job.issue.created', NEW.created_at,
    'JOB', NEW.job_id::text,
    jsonb_build_object('recipient_user_id', recipient_id::text,
      'issue_id', NEW.id::text, 'issue_kind', NEW.kind::text),
    'job.issue', NEW.id::text, NEW.created_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_issue_notify AFTER INSERT ON job_issues
  FOR EACH ROW EXECUTE FUNCTION notify_job_issue();

COMMENT ON TABLE job_progress_acknowledgements IS
  'Customer read acknowledgement only; never commercial consent.';
