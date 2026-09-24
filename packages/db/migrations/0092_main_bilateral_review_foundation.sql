-- R4-017: main bilateral reviews are Job-derived, append-only and sealed.
CREATE TYPE job_main_review_direction AS ENUM (
  'CUSTOMER_TO_PROVIDER', 'PROVIDER_TO_CUSTOMER'
);

CREATE VIEW job_main_review_opportunities
WITH (security_invoker = true)
AS
SELECT evidence.job_id, 'CUSTOMER_TO_PROVIDER'::job_main_review_direction
    AS direction,
  customer.owner_user_id AS author_user_id,
  evidence.primary_craftsman_profile_id AS target_profile_id,
  'CRAFTSMAN_PROFILE'::text AS target_kind,
  evidence.accepted_profession_code,
  evidence.completed_at, evidence.completion_kind,
  (evidence.completed_at AT TIME ZONE 'Europe/Bratislava'
    + interval '14 days') AT TIME ZONE 'Europe/Bratislava'
    AS submission_deadline
FROM completed_job_evidence_provenance evidence
JOIN customer_profiles customer ON customer.id = evidence.customer_profile_id
JOIN craftsman_profiles provider
  ON provider.id = evidence.primary_craftsman_profile_id
WHERE customer.owner_user_id <> provider.owner_user_id
  AND evidence.completion_kind = 'CUSTOMER_ACCEPTED'
UNION ALL
SELECT evidence.job_id, 'PROVIDER_TO_CUSTOMER'::job_main_review_direction,
  provider.owner_user_id, evidence.customer_profile_id,
  'CUSTOMER_PROFILE'::text, evidence.accepted_profession_code,
  evidence.completed_at, evidence.completion_kind,
  (evidence.completed_at AT TIME ZONE 'Europe/Bratislava'
    + interval '14 days') AT TIME ZONE 'Europe/Bratislava'
FROM completed_job_evidence_provenance evidence
JOIN customer_profiles customer ON customer.id = evidence.customer_profile_id
JOIN craftsman_profiles provider
  ON provider.id = evidence.primary_craftsman_profile_id
WHERE customer.owner_user_id <> provider.owner_user_id
  AND evidence.completion_kind = 'CUSTOMER_ACCEPTED';

CREATE TABLE job_main_review_events (
  event_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  direction job_main_review_direction NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ratings jsonb NOT NULL CHECK (jsonb_typeof(ratings) = 'object'),
  comment text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, direction, version)
);

CREATE FUNCTION validate_job_main_review_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  opportunity job_main_review_opportunities%ROWTYPE;
  prior_command job_main_review_events%ROWTYPE;
  expected_keys text[];
  actual_count integer;
  first_at timestamptz;
  latest_version integer;
  now_at timestamptz;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT * INTO prior_command FROM job_main_review_events
  WHERE event_id = NEW.event_id;
  IF FOUND THEN
    IF prior_command.job_id IS NOT DISTINCT FROM NEW.job_id
      AND prior_command.direction IS NOT DISTINCT FROM NEW.direction
      AND prior_command.version IS NOT DISTINCT FROM NEW.version
      AND prior_command.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND prior_command.ratings IS NOT DISTINCT FROM NEW.ratings
      AND prior_command.comment IS NOT DISTINCT FROM NEW.comment THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'review command identifier reuse conflict';
  END IF;
  SELECT * INTO opportunity FROM job_main_review_opportunities
  WHERE job_id = NEW.job_id AND direction = NEW.direction;
  IF NOT FOUND OR NEW.actor_user_id IS DISTINCT FROM opportunity.author_user_id THEN
    RAISE EXCEPTION 'eligible completed Job review author required';
  END IF;
  PERFORM 1 FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active verified review author required';
  END IF;
  IF NEW.direction = 'CUSTOMER_TO_PROVIDER' THEN
    expected_keys := ARRAY[
      'work_quality', 'price_adherence', 'schedule_adherence',
      'communication', 'cleanliness', 'problem_solving',
      'would_hire_again'
    ];
  ELSE
    expected_keys := ARRAY[
      'agreement_payment_experience', 'site_readiness', 'brief_clarity',
      'communication', 'unplanned_changes', 'fairness'
    ];
  END IF;
  SELECT count(*) INTO actual_count FROM jsonb_object_keys(NEW.ratings);
  IF actual_count <> cardinality(expected_keys)
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.ratings) AS item(key)
      WHERE NOT item.key = ANY(expected_keys)
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_each(NEW.ratings) AS item(key, value)
      WHERE item.value <> 'null'::jsonb
        AND item.value::text NOT IN ('1', '2', '3', '4', '5')
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_each(NEW.ratings) AS item(key, value)
      WHERE item.value::text IN ('1', '2', '3', '4', '5')
    ) THEN
    RAISE EXCEPTION 'exact substantive directional review ratings required';
  END IF;
  IF NEW.comment IS NOT NULL AND (
    NEW.comment <> btrim(NEW.comment)
    OR length(NEW.comment) < 1 OR length(NEW.comment) > 2000
    OR NEW.comment ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'invalid review comment';
  END IF;
  now_at := clock_timestamp();
  IF now_at >= opportunity.submission_deadline THEN
    RAISE EXCEPTION 'ordinary review window closed';
  END IF;
  SELECT min(recorded_at), max(version)
    INTO first_at, latest_version
  FROM job_main_review_events
  WHERE job_id = NEW.job_id AND direction = NEW.direction;
  IF first_at IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first review revision required';
    END IF;
  ELSE
    IF NEW.version <> latest_version + 1
      OR now_at >= first_at + interval '60 minutes'
      OR EXISTS (
        SELECT 1 FROM job_main_review_events other
        WHERE other.job_id = NEW.job_id
          AND other.direction <> NEW.direction
          AND other.version = 1
      ) THEN
      RAISE EXCEPTION 'sealed review edit window closed or stale';
    END IF;
  END IF;
  NEW.recorded_at := now_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_main_review_event_validate
BEFORE INSERT ON job_main_review_events
FOR EACH ROW EXECUTE FUNCTION validate_job_main_review_event();

CREATE FUNCTION reject_job_main_review_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job main review history is immutable'; END;
$$;
CREATE TRIGGER job_main_review_event_immutable
BEFORE UPDATE OR DELETE ON job_main_review_events
FOR EACH ROW EXECUTE FUNCTION reject_job_main_review_event_mutation();

CREATE VIEW current_unlocked_job_main_reviews
WITH (security_invoker = true)
AS
WITH firsts AS (
  SELECT job_id, direction, recorded_at AS submitted_at
  FROM job_main_review_events WHERE version = 1
), latest AS (
  SELECT DISTINCT ON (job_id, direction)
    job_id, direction, event_id AS revision_id,
    actor_user_id, ratings, comment, recorded_at AS revised_at
  FROM job_main_review_events
  ORDER BY job_id, direction, version DESC
)
SELECT opportunity.job_id, opportunity.direction,
  opportunity.target_profile_id, opportunity.target_kind,
  opportunity.accepted_profession_code,
  opportunity.completion_kind,
  firsts.submitted_at, latest.revision_id, latest.revised_at,
  latest.actor_user_id, latest.ratings, latest.comment,
  CASE WHEN opposite.submitted_at IS NOT NULL
    THEN greatest(firsts.submitted_at, opposite.submitted_at)
    ELSE opportunity.submission_deadline END AS unlocked_at
FROM job_main_review_opportunities opportunity
JOIN firsts ON firsts.job_id = opportunity.job_id
  AND firsts.direction = opportunity.direction
JOIN latest ON latest.job_id = firsts.job_id
  AND latest.direction = firsts.direction
LEFT JOIN firsts opposite ON opposite.job_id = opportunity.job_id
  AND opposite.direction <> opportunity.direction
WHERE opposite.submitted_at IS NOT NULL
  OR clock_timestamp() >= opportunity.submission_deadline;

COMMENT ON VIEW job_main_review_opportunities IS
  'Private customer-accepted completed-Job review rights with fixed Bratislava-local 14-calendar-day deadline; admin-forced eligibility remains an explicit D22/D23 exception.';
COMMENT ON TABLE job_main_review_events IS
  'Immutable directional submission/edit revisions; event_id is the idempotent command identifier and no body or rating may enter outbox/audit payloads.';
COMMENT ON VIEW current_unlocked_job_main_reviews IS
  'Internal unlocked-only source. A public provider projection must select CUSTOMER_TO_PROVIDER only; customer reviews remain invitation-context private.';
