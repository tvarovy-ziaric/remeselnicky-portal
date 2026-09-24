-- R4-018: optional customer reviews of verified participants and concrete
-- historical JobWorkGroups are distinct from the main bilateral review.

-- Completion is the terminal end of every still-open concrete group interval.
-- This is a successor projection only; assignment/departure history stays
-- immutable and reusable Crew membership is deliberately irrelevant.
CREATE OR REPLACE VIEW current_job_work_group_assignments AS
SELECT assignment.id, assignment.job_id, assignment.work_group_id,
  assignment.participant_id, assignment.assignment_sequence,
  assignment.assigned_by_user_id, assignment.assigned_at,
  departure.event_id AS departure_event_id,
  departure.event_kind::text AS departure_kind,
  departure.actor_user_id AS departed_by_user_id,
  departure.reason AS departure_reason,
  least(departure.recorded_at, participant.left_at,
    state.cancelled_at, completion.completed_at) AS ended_at,
  (departure.event_id IS NULL
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')) AS active
FROM job_work_group_assignments assignment
JOIN current_job_participants participant
  ON participant.id = assignment.participant_id
JOIN current_job_states state ON state.job_id = assignment.job_id
LEFT JOIN completed_job_evidence_provenance completion
  ON completion.job_id = assignment.job_id
LEFT JOIN job_work_group_departure_events departure
  ON departure.assignment_id = assignment.id;

CREATE VIEW verified_completed_job_work_group_assignments
WITH (security_invoker = true)
AS
SELECT participation.job_id, assignment.work_group_id,
  assignment.id AS assignment_id, participation.participant_id,
  participation.individual_profile_id,
  greatest(assignment.assigned_at,
    participation.participation_started_at) AS overlap_started_at,
  least(assignment.ended_at,
    participation.participation_ended_at) AS overlap_ended_at,
  assignment.assigned_at, assignment.ended_at,
  participation.completed_at, participation.completion_decision_id
FROM verified_individual_completed_job_participation participation
JOIN current_job_work_group_assignments assignment
  ON assignment.job_id = participation.job_id
  AND assignment.participant_id = participation.participant_id
WHERE participation.completion_kind = 'CUSTOMER_ACCEPTED'
  AND assignment.ended_at IS NOT NULL
  AND least(assignment.ended_at,
    participation.participation_ended_at)
    > greatest(assignment.assigned_at,
      participation.participation_started_at);

CREATE TYPE job_context_review_target_kind AS ENUM (
  'PARTICIPANT', 'WORK_GROUP'
);

CREATE VIEW job_context_review_opportunities
WITH (security_invoker = true)
AS
SELECT participation.job_id,
  'PARTICIPANT'::job_context_review_target_kind AS target_kind,
  participation.participant_id, NULL::uuid AS work_group_id,
  participation.individual_profile_id AS participant_profile_id,
  customer.owner_user_id AS author_user_id,
  participation.completion_decision_id,
  participation.completed_at,
  (participation.completed_at AT TIME ZONE 'Europe/Bratislava'
    + interval '14 days') AT TIME ZONE 'Europe/Bratislava'
    AS submission_deadline
FROM verified_individual_completed_job_participation participation
JOIN customer_profiles customer
  ON customer.id = participation.customer_profile_id
JOIN craftsman_profiles target
  ON target.id = participation.individual_profile_id
WHERE participation.completion_kind = 'CUSTOMER_ACCEPTED'
  AND participation.completion_decision_id IS NOT NULL
  AND customer.owner_user_id <> target.owner_user_id
UNION ALL
SELECT completion.job_id,
  'WORK_GROUP'::job_context_review_target_kind,
  NULL::uuid, work_group.id, NULL::uuid,
  customer.owner_user_id, completion.completion_decision_id,
  completion.completed_at,
  (completion.completed_at AT TIME ZONE 'Europe/Bratislava'
    + interval '14 days') AT TIME ZONE 'Europe/Bratislava'
FROM completed_job_evidence_provenance completion
JOIN customer_profiles customer
  ON customer.id = completion.customer_profile_id
JOIN craftsman_profiles provider
  ON provider.id = completion.primary_craftsman_profile_id
JOIN job_work_groups work_group ON work_group.job_id = completion.job_id
WHERE completion.completion_kind = 'CUSTOMER_ACCEPTED'
  AND completion.completion_decision_id IS NOT NULL
  AND customer.owner_user_id <> provider.owner_user_id
  AND customer.owner_user_id <> work_group.created_by_user_id
  AND EXISTS (
    SELECT 1
    FROM verified_completed_job_work_group_assignments assignment
    WHERE assignment.job_id = completion.job_id
      AND assignment.work_group_id = work_group.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM verified_completed_job_work_group_assignments assignment
    JOIN craftsman_profiles member
      ON member.id = assignment.individual_profile_id
    WHERE assignment.job_id = completion.job_id
      AND assignment.work_group_id = work_group.id
      AND member.owner_user_id = customer.owner_user_id
  );

CREATE TABLE job_context_reviews (
  review_id uuid PRIMARY KEY,
  create_command_id uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  target_kind job_context_review_target_kind NOT NULL,
  participant_id uuid,
  work_group_id uuid,
  participant_profile_id uuid
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  completion_decision_id uuid NOT NULL
    REFERENCES job_completion_decisions(id) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL,
  submission_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id, participant_id)
    REFERENCES job_participants(job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, work_group_id)
    REFERENCES job_work_groups(job_id, id) ON DELETE RESTRICT,
  CONSTRAINT job_context_review_exact_target CHECK (
    (target_kind = 'PARTICIPANT'
      AND participant_id IS NOT NULL AND work_group_id IS NULL
      AND participant_profile_id IS NOT NULL)
    OR (target_kind = 'WORK_GROUP'
      AND participant_id IS NULL AND work_group_id IS NOT NULL
      AND participant_profile_id IS NULL)
  ),
  CONSTRAINT job_context_review_deadline CHECK (
    submission_deadline > completed_at
  )
);
CREATE UNIQUE INDEX job_context_review_one_participant
  ON job_context_reviews (job_id, participant_id)
  WHERE target_kind = 'PARTICIPANT';
CREATE UNIQUE INDEX job_context_review_one_work_group
  ON job_context_reviews (job_id, work_group_id)
  WHERE target_kind = 'WORK_GROUP';

CREATE TABLE job_participant_review_capability_snapshots (
  review_id uuid NOT NULL
    REFERENCES job_context_reviews(review_id) ON DELETE RESTRICT,
  claim_id uuid NOT NULL
    REFERENCES job_participant_capability_claims(id) ON DELETE RESTRICT,
  kind job_participant_capability_kind NOT NULL,
  profession_taxonomy_release_id uuid,
  profession_code text,
  skill_catalog_release_id uuid,
  skill_code text,
  custom_skill_text text,
  proposed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_at timestamptz NOT NULL,
  confirmed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (review_id, claim_id)
);

CREATE TABLE job_participant_review_role_snapshots (
  review_id uuid NOT NULL
    REFERENCES job_context_reviews(review_id) ON DELETE RESTRICT,
  source_role_id uuid NOT NULL,
  role text NOT NULL,
  role_started_at timestamptz NOT NULL,
  role_ended_at timestamptz NOT NULL,
  assignment_event_id uuid
    REFERENCES job_participant_role_events(event_id) ON DELETE RESTRICT,
  role_decision_id uuid
    REFERENCES job_participant_role_decisions(decision_id) ON DELETE RESTRICT,
  role_confirmed_at timestamptz,
  PRIMARY KEY (review_id, source_role_id, role)
);

CREATE TABLE job_work_group_review_assignment_snapshots (
  review_id uuid NOT NULL
    REFERENCES job_context_reviews(review_id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL
    REFERENCES job_work_group_assignments(id) ON DELETE RESTRICT,
  participant_id uuid NOT NULL
    REFERENCES job_participants(id) ON DELETE RESTRICT,
  individual_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  overlap_started_at timestamptz NOT NULL,
  overlap_ended_at timestamptz NOT NULL,
  PRIMARY KEY (review_id, assignment_id),
  CHECK (overlap_ended_at > overlap_started_at)
);

CREATE TABLE job_context_review_revisions (
  event_id uuid PRIMARY KEY,
  review_id uuid NOT NULL
    REFERENCES job_context_reviews(review_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ratings jsonb NOT NULL CHECK (jsonb_typeof(ratings) = 'object'),
  comment text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (review_id, version)
);

CREATE FUNCTION validate_job_context_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior_command job_context_reviews%ROWTYPE;
  opportunity job_context_review_opportunities%ROWTYPE;
  now_at timestamptz;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT * INTO prior_command FROM job_context_reviews
  WHERE create_command_id = NEW.create_command_id;
  IF FOUND THEN
    IF prior_command.review_id IS NOT DISTINCT FROM NEW.review_id
      AND prior_command.job_id IS NOT DISTINCT FROM NEW.job_id
      AND prior_command.target_kind IS NOT DISTINCT FROM NEW.target_kind
      AND prior_command.participant_id IS NOT DISTINCT FROM NEW.participant_id
      AND prior_command.work_group_id IS NOT DISTINCT FROM NEW.work_group_id
      AND prior_command.author_user_id IS NOT DISTINCT FROM NEW.author_user_id
    THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'context review command identifier reuse conflict';
  END IF;

  SELECT * INTO opportunity
  FROM job_context_review_opportunities eligible
  WHERE eligible.job_id = NEW.job_id
    AND eligible.target_kind = NEW.target_kind
    AND eligible.participant_id IS NOT DISTINCT FROM NEW.participant_id
    AND eligible.work_group_id IS NOT DISTINCT FROM NEW.work_group_id;
  IF NOT FOUND
    OR NEW.author_user_id IS DISTINCT FROM opportunity.author_user_id THEN
    RAISE EXCEPTION 'eligible verified completed-Job review target required';
  END IF;

  PERFORM 1
  FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.author_user_id
    AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active verified customer review author required';
  END IF;

  now_at := clock_timestamp();
  IF now_at >= opportunity.submission_deadline THEN
    RAISE EXCEPTION 'ordinary context review window closed';
  END IF;
  NEW.participant_profile_id := opportunity.participant_profile_id;
  NEW.completion_decision_id := opportunity.completion_decision_id;
  NEW.completed_at := opportunity.completed_at;
  NEW.submission_deadline := opportunity.submission_deadline;
  NEW.created_at := now_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_context_review_validate
BEFORE INSERT ON job_context_reviews
FOR EACH ROW EXECUTE FUNCTION validate_job_context_review();

CREATE FUNCTION validate_job_participant_review_capability_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_row job_context_reviews%ROWTYPE;
BEGIN
  SELECT * INTO review_row FROM job_context_reviews
  WHERE review_id = NEW.review_id FOR SHARE;
  IF NOT FOUND OR review_row.target_kind <> 'PARTICIPANT' THEN
    RAISE EXCEPTION 'participant review required for capability snapshot';
  END IF;
  PERFORM 1
  FROM verified_completed_job_capabilities capability
  WHERE capability.job_id = review_row.job_id
    AND capability.participant_id = review_row.participant_id
    AND capability.claim_id = NEW.claim_id
    AND capability.kind IS NOT DISTINCT FROM NEW.kind
    AND capability.profession_taxonomy_release_id
      IS NOT DISTINCT FROM NEW.profession_taxonomy_release_id
    AND capability.profession_code
      IS NOT DISTINCT FROM NEW.profession_code
    AND capability.skill_catalog_release_id
      IS NOT DISTINCT FROM NEW.skill_catalog_release_id
    AND capability.skill_code IS NOT DISTINCT FROM NEW.skill_code
    AND capability.custom_skill_text
      IS NOT DISTINCT FROM NEW.custom_skill_text
    AND capability.proposed_by_user_id
      IS NOT DISTINCT FROM NEW.proposed_by_user_id
    AND capability.proposed_at IS NOT DISTINCT FROM NEW.proposed_at
    AND capability.confirmed_by_user_id
      IS NOT DISTINCT FROM NEW.confirmed_by_user_id
    AND capability.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact verified completed-Job capability required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_participant_review_capability_snapshot_validate
BEFORE INSERT ON job_participant_review_capability_snapshots
FOR EACH ROW EXECUTE FUNCTION
  validate_job_participant_review_capability_snapshot();

CREATE FUNCTION validate_job_participant_review_role_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_row job_context_reviews%ROWTYPE;
BEGIN
  SELECT * INTO review_row FROM job_context_reviews
  WHERE review_id = NEW.review_id FOR SHARE;
  IF NOT FOUND OR review_row.target_kind <> 'PARTICIPANT' THEN
    RAISE EXCEPTION 'participant review required for role snapshot';
  END IF;
  PERFORM 1
  FROM verified_completed_job_roles role_evidence
  WHERE role_evidence.job_id = review_row.job_id
    AND role_evidence.participant_id = review_row.participant_id
    AND coalesce(role_evidence.assignment_event_id,
      role_evidence.participant_id) = NEW.source_role_id
    AND role_evidence.role IS NOT DISTINCT FROM NEW.role
    AND role_evidence.role_started_at
      IS NOT DISTINCT FROM NEW.role_started_at
    AND role_evidence.role_ended_at IS NOT DISTINCT FROM NEW.role_ended_at
    AND role_evidence.assignment_event_id
      IS NOT DISTINCT FROM NEW.assignment_event_id
    AND role_evidence.role_decision_id
      IS NOT DISTINCT FROM NEW.role_decision_id
    AND role_evidence.role_confirmed_at
      IS NOT DISTINCT FROM NEW.role_confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact verified completed-Job role required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_participant_review_role_snapshot_validate
BEFORE INSERT ON job_participant_review_role_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_review_role_snapshot();

CREATE FUNCTION validate_job_work_group_review_assignment_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_row job_context_reviews%ROWTYPE;
BEGIN
  SELECT * INTO review_row FROM job_context_reviews
  WHERE review_id = NEW.review_id FOR SHARE;
  IF NOT FOUND OR review_row.target_kind <> 'WORK_GROUP' THEN
    RAISE EXCEPTION 'work-group review required for assignment snapshot';
  END IF;
  PERFORM 1
  FROM verified_completed_job_work_group_assignments assignment
  WHERE assignment.job_id = review_row.job_id
    AND assignment.work_group_id = review_row.work_group_id
    AND assignment.assignment_id = NEW.assignment_id
    AND assignment.participant_id IS NOT DISTINCT FROM NEW.participant_id
    AND assignment.individual_profile_id
      IS NOT DISTINCT FROM NEW.individual_profile_id
    AND assignment.assigned_at IS NOT DISTINCT FROM NEW.assigned_at
    AND assignment.ended_at IS NOT DISTINCT FROM NEW.ended_at
    AND assignment.overlap_started_at
      IS NOT DISTINCT FROM NEW.overlap_started_at
    AND assignment.overlap_ended_at
      IS NOT DISTINCT FROM NEW.overlap_ended_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact verified work-group assignment overlap required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_work_group_review_assignment_snapshot_validate
BEFORE INSERT ON job_work_group_review_assignment_snapshots
FOR EACH ROW EXECUTE FUNCTION
  validate_job_work_group_review_assignment_snapshot();

CREATE FUNCTION snapshot_job_context_review_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind = 'PARTICIPANT' THEN
    INSERT INTO job_participant_review_capability_snapshots (
      review_id, claim_id, kind,
      profession_taxonomy_release_id, profession_code,
      skill_catalog_release_id, skill_code, custom_skill_text,
      proposed_by_user_id, proposed_at, confirmed_by_user_id, confirmed_at
    )
    SELECT NEW.review_id, capability.claim_id, capability.kind,
      capability.profession_taxonomy_release_id, capability.profession_code,
      capability.skill_catalog_release_id, capability.skill_code,
      capability.custom_skill_text, capability.proposed_by_user_id,
      capability.proposed_at, capability.confirmed_by_user_id,
      capability.confirmed_at
    FROM verified_completed_job_capabilities capability
    WHERE capability.job_id = NEW.job_id
      AND capability.participant_id = NEW.participant_id;

    INSERT INTO job_participant_review_role_snapshots (
      review_id, source_role_id, role, role_started_at, role_ended_at,
      assignment_event_id, role_decision_id, role_confirmed_at
    )
    SELECT NEW.review_id,
      coalesce(role_evidence.assignment_event_id,
        role_evidence.participant_id) AS source_role_id,
      role_evidence.role, role_evidence.role_started_at,
      role_evidence.role_ended_at, role_evidence.assignment_event_id,
      role_evidence.role_decision_id, role_evidence.role_confirmed_at
    FROM verified_completed_job_roles role_evidence
    WHERE role_evidence.job_id = NEW.job_id
      AND role_evidence.participant_id = NEW.participant_id;
  ELSE
    INSERT INTO job_work_group_review_assignment_snapshots (
      review_id, assignment_id, participant_id, individual_profile_id,
      assigned_at, ended_at, overlap_started_at, overlap_ended_at
    )
    SELECT NEW.review_id, assignment.assignment_id,
      assignment.participant_id, assignment.individual_profile_id,
      assignment.assigned_at, assignment.ended_at,
      assignment.overlap_started_at, assignment.overlap_ended_at
    FROM verified_completed_job_work_group_assignments assignment
    WHERE assignment.job_id = NEW.job_id
      AND assignment.work_group_id = NEW.work_group_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_context_review_snapshot_provenance
AFTER INSERT ON job_context_reviews
FOR EACH ROW EXECUTE FUNCTION snapshot_job_context_review_provenance();

CREATE FUNCTION validate_job_context_review_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_row job_context_reviews%ROWTYPE;
  prior_command job_context_review_revisions%ROWTYPE;
  expected_keys text[];
  actual_count integer;
  first_at timestamptz;
  latest_version integer;
  now_at timestamptz;
BEGIN
  -- Preserve the global Job -> logical review lock order used by the
  -- repository and header trigger. Reading the immutable header first is
  -- safe and lets us identify the Job without taking the narrower lock.
  SELECT * INTO review_row FROM job_context_reviews
  WHERE review_id = NEW.review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context review required';
  END IF;
  PERFORM 1 FROM jobs WHERE id = review_row.job_id FOR UPDATE;
  SELECT * INTO review_row FROM job_context_reviews
  WHERE review_id = NEW.review_id FOR UPDATE;
  SELECT * INTO prior_command FROM job_context_review_revisions
  WHERE event_id = NEW.event_id;
  IF FOUND THEN
    IF prior_command.review_id IS NOT DISTINCT FROM NEW.review_id
      AND prior_command.version IS NOT DISTINCT FROM NEW.version
      AND prior_command.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND prior_command.ratings IS NOT DISTINCT FROM NEW.ratings
      AND prior_command.comment IS NOT DISTINCT FROM NEW.comment THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'context review event identifier reuse conflict';
  END IF;

  IF NEW.actor_user_id IS DISTINCT FROM review_row.author_user_id THEN
    RAISE EXCEPTION 'context review author required';
  END IF;
  PERFORM 1
  FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.actor_user_id
    AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active verified customer review author required';
  END IF;

  IF review_row.target_kind = 'PARTICIPANT' THEN
    expected_keys := ARRAY[
      'work_quality', 'price_adherence', 'schedule_adherence',
      'communication', 'cleanliness', 'problem_solving',
      'would_hire_again'
    ];
  ELSE
    expected_keys := ARRAY[
      'result_quality', 'coordination', 'timing', 'communication',
      'cleanliness', 'problem_solving'
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
    RAISE EXCEPTION 'exact substantive target-specific review ratings required';
  END IF;
  IF NEW.comment IS NOT NULL AND (
    NEW.comment <> btrim(NEW.comment)
    OR length(NEW.comment) < 1 OR length(NEW.comment) > 2000
    OR NEW.comment ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'invalid context review comment';
  END IF;

  now_at := clock_timestamp();
  IF now_at >= review_row.submission_deadline THEN
    RAISE EXCEPTION 'ordinary context review window closed';
  END IF;
  SELECT min(recorded_at), max(version)
    INTO first_at, latest_version
  FROM job_context_review_revisions
  WHERE review_id = NEW.review_id;
  IF first_at IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first context review revision required';
    END IF;
  ELSIF NEW.version <> latest_version + 1
      OR now_at >= least(first_at + interval '60 minutes',
        review_row.submission_deadline) THEN
    RAISE EXCEPTION 'context review edit window closed or stale';
  END IF;
  NEW.recorded_at := now_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_context_review_revision_validate
BEFORE INSERT ON job_context_review_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_context_review_revision();

CREATE FUNCTION require_initial_job_context_review_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_context_review_revisions revision
    WHERE revision.review_id = NEW.review_id AND revision.version = 1
  ) THEN
    RAISE EXCEPTION 'context review requires an initial revision';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER job_context_review_initial_revision
AFTER INSERT ON job_context_reviews
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_initial_job_context_review_revision();

CREATE FUNCTION reject_job_context_review_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job context review history is immutable';
END;
$$;
CREATE TRIGGER job_context_review_immutable
BEFORE UPDATE OR DELETE ON job_context_reviews
FOR EACH ROW EXECUTE FUNCTION reject_job_context_review_mutation();
CREATE TRIGGER job_context_review_revision_immutable
BEFORE UPDATE OR DELETE ON job_context_review_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_context_review_mutation();
CREATE TRIGGER job_participant_review_capability_snapshot_immutable
BEFORE UPDATE OR DELETE ON job_participant_review_capability_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_context_review_mutation();
CREATE TRIGGER job_participant_review_role_snapshot_immutable
BEFORE UPDATE OR DELETE ON job_participant_review_role_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_context_review_mutation();
CREATE TRIGGER job_work_group_review_assignment_snapshot_immutable
BEFORE UPDATE OR DELETE ON job_work_group_review_assignment_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_context_review_mutation();

CREATE VIEW current_job_context_reviews
WITH (security_invoker = true)
AS
WITH firsts AS (
  SELECT review_id, recorded_at AS submitted_at
  FROM job_context_review_revisions WHERE version = 1
), latest AS (
  SELECT DISTINCT ON (review_id) review_id, event_id AS revision_id,
    version, ratings, comment, recorded_at AS revised_at
  FROM job_context_review_revisions
  ORDER BY review_id, version DESC
)
SELECT review.review_id, review.job_id, review.target_kind,
  review.participant_id, review.work_group_id,
  review.participant_profile_id, review.author_user_id,
  review.completion_decision_id, review.completed_at,
  review.submission_deadline, firsts.submitted_at,
  least(firsts.submitted_at + interval '60 minutes',
    review.submission_deadline) AS edit_deadline,
  latest.revision_id, latest.version, latest.ratings,
  latest.comment, latest.revised_at
FROM job_context_reviews review
JOIN firsts ON firsts.review_id = review.review_id
JOIN latest ON latest.review_id = review.review_id;

COMMENT ON VIEW verified_completed_job_work_group_assignments IS
  'Private historical JobWorkGroup provenance: explicit assignment intervals with positive verified execution overlap; never reusable Crew membership.';
COMMENT ON VIEW job_context_review_opportunities IS
  'Private optional customer rights for verified participants and concrete historical JobWorkGroups after customer-accepted completion.';
COMMENT ON TABLE job_context_reviews IS
  'Immutable logical secondary customer review identity and completed-Job target provenance; exactly one participant or work-group target.';
COMMENT ON TABLE job_context_review_revisions IS
  'Immutable command-idempotent target-specific ratings and optional comment revisions. Bodies must not enter logs, analytics, audit or notification payloads.';
COMMENT ON TABLE job_participant_review_capability_snapshots IS
  'Immutable participant review context copied only from verified completed-Job capability evidence.';
COMMENT ON TABLE job_participant_review_role_snapshots IS
  'Immutable participant review context copied only from verified completed-Job role evidence.';
COMMENT ON TABLE job_work_group_review_assignment_snapshots IS
  'Immutable historical team roster provenance; work-group scores remain separate and are never propagated to member reputation.';
COMMENT ON VIEW current_job_context_reviews IS
  'Private latest secondary-review state. It is not a public unlock projection; participant publication must wait for the edit lock and main bilateral seal, and work-group evidence has no public Crew surface.';
