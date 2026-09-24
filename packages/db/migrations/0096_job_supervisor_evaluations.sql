-- R4-019: supervisor evaluations are private, Job-contextual technical
-- evidence. They are neither bilateral customer reviews nor arbitrary peer
-- ratings, and their public contribution is limited to profession-scoped
-- aggregate evidence volume until a governed scoring formula exists.

CREATE TYPE job_supervisor_relationship_kind AS ENUM (
  'PRIMARY_CONTRACTOR', 'LEAD', 'COORDINATOR', 'SITE_MANAGER'
);

CREATE VIEW job_supervisor_evaluation_relationships
WITH (security_invoker = true)
AS
SELECT target.job_id, target.participant_id AS target_participant_id,
  target.individual_profile_id AS target_profile_id,
  provider.owner_user_id AS evaluator_user_id,
  'PRIMARY_CONTRACTOR'::job_supervisor_relationship_kind
    AS relationship_kind,
  NULL::uuid AS evaluator_participant_id,
  NULL::uuid AS evaluator_role_assignment_event_id,
  NULL::uuid AS shared_work_group_id,
  target.participation_started_at AS overlap_started_at,
  target.participation_ended_at AS overlap_ended_at,
  target.completion_decision_id, target.completed_at
FROM verified_individual_completed_job_participation target
JOIN jobs job ON job.id = target.job_id
JOIN craftsman_profiles provider
  ON provider.id = job.primary_craftsman_profile_id
JOIN craftsman_profiles target_profile
  ON target_profile.id = target.individual_profile_id
WHERE target.completion_kind = 'CUSTOMER_ACCEPTED'
  AND target.completion_decision_id IS NOT NULL
  AND provider.owner_user_id <> target_profile.owner_user_id
  AND target.participation_ended_at > target.participation_started_at
UNION ALL
SELECT target.job_id, target.participant_id,
  target.individual_profile_id, evaluator_profile.owner_user_id,
  evaluator_role.role::job_supervisor_relationship_kind,
  evaluator.participant_id, evaluator_role.assignment_event_id,
  NULL::uuid,
  greatest(evaluator_role.role_started_at,
    target.participation_started_at) AS overlap_started_at,
  least(evaluator_role.role_ended_at,
    target.participation_ended_at) AS overlap_ended_at,
  target.completion_decision_id, target.completed_at
FROM verified_individual_completed_job_participation target
JOIN verified_individual_completed_job_participation evaluator
  ON evaluator.job_id = target.job_id
JOIN verified_completed_job_roles evaluator_role
  ON evaluator_role.job_id = evaluator.job_id
  AND evaluator_role.participant_id = evaluator.participant_id
  AND evaluator_role.role IN ('COORDINATOR', 'SITE_MANAGER')
JOIN craftsman_profiles evaluator_profile
  ON evaluator_profile.id = evaluator.individual_profile_id
JOIN craftsman_profiles target_profile
  ON target_profile.id = target.individual_profile_id
WHERE target.completion_kind = 'CUSTOMER_ACCEPTED'
  AND evaluator.completion_kind = 'CUSTOMER_ACCEPTED'
  AND target.completion_decision_id IS NOT NULL
  AND evaluator.participant_id <> target.participant_id
  AND evaluator_profile.owner_user_id <> target_profile.owner_user_id
  AND least(evaluator_role.role_ended_at,
      target.participation_ended_at)
    > greatest(evaluator_role.role_started_at,
      target.participation_started_at)
UNION ALL
SELECT target.job_id, target.participant_id,
  target.individual_profile_id, evaluator_profile.owner_user_id,
  'LEAD'::job_supervisor_relationship_kind,
  evaluator.participant_id, evaluator_role.assignment_event_id,
  evaluator_group.work_group_id,
  greatest(evaluator_role.role_started_at,
    target.participation_started_at,
    evaluator_group.overlap_started_at,
    target_group.overlap_started_at) AS overlap_started_at,
  least(evaluator_role.role_ended_at,
    target.participation_ended_at,
    evaluator_group.overlap_ended_at,
    target_group.overlap_ended_at) AS overlap_ended_at,
  target.completion_decision_id, target.completed_at
FROM verified_individual_completed_job_participation target
JOIN verified_individual_completed_job_participation evaluator
  ON evaluator.job_id = target.job_id
JOIN verified_completed_job_roles evaluator_role
  ON evaluator_role.job_id = evaluator.job_id
  AND evaluator_role.participant_id = evaluator.participant_id
  AND evaluator_role.role = 'LEAD'
JOIN verified_completed_job_work_group_assignments evaluator_group
  ON evaluator_group.job_id = evaluator.job_id
  AND evaluator_group.participant_id = evaluator.participant_id
JOIN verified_completed_job_work_group_assignments target_group
  ON target_group.job_id = target.job_id
  AND target_group.participant_id = target.participant_id
  AND target_group.work_group_id = evaluator_group.work_group_id
JOIN craftsman_profiles evaluator_profile
  ON evaluator_profile.id = evaluator.individual_profile_id
JOIN craftsman_profiles target_profile
  ON target_profile.id = target.individual_profile_id
WHERE target.completion_kind = 'CUSTOMER_ACCEPTED'
  AND evaluator.completion_kind = 'CUSTOMER_ACCEPTED'
  AND target.completion_decision_id IS NOT NULL
  AND evaluator.participant_id <> target.participant_id
  AND evaluator_profile.owner_user_id <> target_profile.owner_user_id
  AND least(evaluator_role.role_ended_at,
      target.participation_ended_at,
      evaluator_group.overlap_ended_at,
      target_group.overlap_ended_at)
    > greatest(evaluator_role.role_started_at,
      target.participation_started_at,
      evaluator_group.overlap_started_at,
      target_group.overlap_started_at);

CREATE VIEW job_supervisor_evaluation_opportunities
WITH (security_invoker = true)
AS
SELECT job_id, target_participant_id, target_profile_id,
  evaluator_user_id, relationship_kind, evaluator_participant_id,
  evaluator_role_assignment_event_id, shared_work_group_id,
  overlap_started_at, overlap_ended_at, completion_decision_id,
  completed_at,
  (completed_at AT TIME ZONE 'Europe/Bratislava' + interval '14 days')
    AT TIME ZONE 'Europe/Bratislava' AS submission_deadline
FROM (
  SELECT relationship.*,
    row_number() OVER (
      PARTITION BY relationship.job_id, relationship.evaluator_user_id,
        relationship.target_participant_id
      ORDER BY CASE relationship.relationship_kind
        WHEN 'PRIMARY_CONTRACTOR' THEN 1
        WHEN 'SITE_MANAGER' THEN 2
        WHEN 'COORDINATOR' THEN 3
        ELSE 4 END,
        relationship.overlap_ended_at - relationship.overlap_started_at DESC,
        relationship.evaluator_role_assignment_event_id NULLS FIRST,
        relationship.shared_work_group_id NULLS FIRST
    ) AS relationship_rank
  FROM job_supervisor_evaluation_relationships relationship
) ranked
WHERE relationship_rank = 1;

CREATE TABLE job_supervisor_evaluations (
  evaluation_id uuid PRIMARY KEY,
  create_command_id uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  target_participant_id uuid NOT NULL,
  target_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  evaluator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  relationship_kind job_supervisor_relationship_kind NOT NULL,
  evaluator_participant_id uuid,
  evaluator_role_assignment_event_id uuid
    REFERENCES job_participant_role_events(event_id) ON DELETE RESTRICT,
  shared_work_group_id uuid,
  overlap_started_at timestamptz NOT NULL,
  overlap_ended_at timestamptz NOT NULL,
  completion_decision_id uuid NOT NULL
    REFERENCES job_completion_decisions(id) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL,
  submission_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id, target_participant_id)
    REFERENCES job_participants(job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, evaluator_participant_id)
    REFERENCES job_participants(job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, shared_work_group_id)
    REFERENCES job_work_groups(job_id, id) ON DELETE RESTRICT,
  UNIQUE (job_id, evaluator_user_id, target_participant_id),
  CONSTRAINT job_supervisor_evaluation_overlap CHECK (
    overlap_ended_at > overlap_started_at
  ),
  CONSTRAINT job_supervisor_evaluation_deadline CHECK (
    submission_deadline > completed_at
  ),
  CONSTRAINT job_supervisor_evaluation_relationship_shape CHECK (
    (relationship_kind = 'PRIMARY_CONTRACTOR'
      AND evaluator_participant_id IS NULL
      AND evaluator_role_assignment_event_id IS NULL
      AND shared_work_group_id IS NULL)
    OR (relationship_kind IN ('COORDINATOR', 'SITE_MANAGER')
      AND evaluator_participant_id IS NOT NULL
      AND evaluator_role_assignment_event_id IS NOT NULL
      AND shared_work_group_id IS NULL)
    OR (relationship_kind = 'LEAD'
      AND evaluator_participant_id IS NOT NULL
      AND evaluator_role_assignment_event_id IS NOT NULL
      AND shared_work_group_id IS NOT NULL)
  )
);

CREATE TABLE job_supervisor_evaluation_profession_snapshots (
  evaluation_id uuid NOT NULL
    REFERENCES job_supervisor_evaluations(evaluation_id) ON DELETE RESTRICT,
  claim_id uuid NOT NULL
    REFERENCES job_participant_capability_claims(id) ON DELETE RESTRICT,
  profession_taxonomy_release_id uuid NOT NULL,
  profession_code text NOT NULL,
  proposed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  proposed_at timestamptz NOT NULL,
  confirmed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (evaluation_id, claim_id)
);

CREATE TABLE job_supervisor_evaluation_role_snapshots (
  evaluation_id uuid NOT NULL
    REFERENCES job_supervisor_evaluations(evaluation_id) ON DELETE RESTRICT,
  source_role_id uuid NOT NULL,
  role text NOT NULL,
  role_started_at timestamptz NOT NULL,
  role_ended_at timestamptz NOT NULL,
  assignment_event_id uuid
    REFERENCES job_participant_role_events(event_id) ON DELETE RESTRICT,
  role_decision_id uuid
    REFERENCES job_participant_role_decisions(decision_id) ON DELETE RESTRICT,
  role_confirmed_at timestamptz,
  PRIMARY KEY (evaluation_id, source_role_id, role)
);

CREATE TABLE job_supervisor_evaluation_revisions (
  event_id uuid PRIMARY KEY,
  evaluation_id uuid NOT NULL
    REFERENCES job_supervisor_evaluations(evaluation_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ratings jsonb NOT NULL CHECK (jsonb_typeof(ratings) = 'object'),
  comment text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (evaluation_id, version)
);

CREATE FUNCTION validate_job_supervisor_evaluation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior_command job_supervisor_evaluations%ROWTYPE;
  opportunity job_supervisor_evaluation_opportunities%ROWTYPE;
  now_at timestamptz;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT * INTO prior_command FROM job_supervisor_evaluations
  WHERE create_command_id = NEW.create_command_id;
  IF FOUND THEN
    IF prior_command.evaluation_id IS NOT DISTINCT FROM NEW.evaluation_id
      AND prior_command.job_id IS NOT DISTINCT FROM NEW.job_id
      AND prior_command.target_participant_id
        IS NOT DISTINCT FROM NEW.target_participant_id
      AND prior_command.evaluator_user_id
        IS NOT DISTINCT FROM NEW.evaluator_user_id THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'supervisor evaluation command identifier reuse conflict';
  END IF;

  SELECT * INTO opportunity
  FROM job_supervisor_evaluation_opportunities eligible
  WHERE eligible.job_id = NEW.job_id
    AND eligible.target_participant_id = NEW.target_participant_id
    AND eligible.evaluator_user_id = NEW.evaluator_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible supervisor relationship required';
  END IF;
  PERFORM 1 FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.evaluator_user_id
    AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active verified supervisor required';
  END IF;
  now_at := clock_timestamp();
  IF now_at >= opportunity.submission_deadline THEN
    RAISE EXCEPTION 'ordinary supervisor evaluation window closed';
  END IF;

  NEW.target_profile_id := opportunity.target_profile_id;
  NEW.relationship_kind := opportunity.relationship_kind;
  NEW.evaluator_participant_id := opportunity.evaluator_participant_id;
  NEW.evaluator_role_assignment_event_id :=
    opportunity.evaluator_role_assignment_event_id;
  NEW.shared_work_group_id := opportunity.shared_work_group_id;
  NEW.overlap_started_at := opportunity.overlap_started_at;
  NEW.overlap_ended_at := opportunity.overlap_ended_at;
  NEW.completion_decision_id := opportunity.completion_decision_id;
  NEW.completed_at := opportunity.completed_at;
  NEW.submission_deadline := opportunity.submission_deadline;
  NEW.created_at := now_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_supervisor_evaluation_validate
BEFORE INSERT ON job_supervisor_evaluations
FOR EACH ROW EXECUTE FUNCTION validate_job_supervisor_evaluation();

CREATE FUNCTION validate_job_supervisor_profession_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evaluation job_supervisor_evaluations%ROWTYPE;
BEGIN
  SELECT * INTO evaluation FROM job_supervisor_evaluations
  WHERE evaluation_id = NEW.evaluation_id FOR SHARE;
  PERFORM 1 FROM verified_completed_job_capabilities capability
  WHERE capability.job_id = evaluation.job_id
    AND capability.participant_id = evaluation.target_participant_id
    AND capability.claim_id = NEW.claim_id
    AND capability.kind = 'PROFESSION'
    AND capability.profession_taxonomy_release_id
      IS NOT DISTINCT FROM NEW.profession_taxonomy_release_id
    AND capability.profession_code IS NOT DISTINCT FROM NEW.profession_code
    AND capability.proposed_by_user_id
      IS NOT DISTINCT FROM NEW.proposed_by_user_id
    AND capability.proposed_at IS NOT DISTINCT FROM NEW.proposed_at
    AND capability.confirmed_by_user_id
      IS NOT DISTINCT FROM NEW.confirmed_by_user_id
    AND capability.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact verified target profession required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_supervisor_profession_snapshot_validate
BEFORE INSERT ON job_supervisor_evaluation_profession_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_job_supervisor_profession_snapshot();

CREATE FUNCTION validate_job_supervisor_role_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evaluation job_supervisor_evaluations%ROWTYPE;
BEGIN
  SELECT * INTO evaluation FROM job_supervisor_evaluations
  WHERE evaluation_id = NEW.evaluation_id FOR SHARE;
  PERFORM 1 FROM verified_completed_job_roles role_evidence
  WHERE role_evidence.job_id = evaluation.job_id
    AND role_evidence.participant_id = evaluation.target_participant_id
    AND coalesce(role_evidence.assignment_event_id,
      role_evidence.participant_id) = NEW.source_role_id
    AND role_evidence.role IS NOT DISTINCT FROM NEW.role
    AND role_evidence.role_started_at IS NOT DISTINCT FROM NEW.role_started_at
    AND role_evidence.role_ended_at IS NOT DISTINCT FROM NEW.role_ended_at
    AND role_evidence.assignment_event_id
      IS NOT DISTINCT FROM NEW.assignment_event_id
    AND role_evidence.role_decision_id
      IS NOT DISTINCT FROM NEW.role_decision_id
    AND role_evidence.role_confirmed_at
      IS NOT DISTINCT FROM NEW.role_confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact verified target role required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_supervisor_role_snapshot_validate
BEFORE INSERT ON job_supervisor_evaluation_role_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_job_supervisor_role_snapshot();

CREATE FUNCTION snapshot_job_supervisor_evaluation_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO job_supervisor_evaluation_profession_snapshots (
    evaluation_id, claim_id, profession_taxonomy_release_id,
    profession_code, proposed_by_user_id, proposed_at,
    confirmed_by_user_id, confirmed_at
  )
  SELECT NEW.evaluation_id, capability.claim_id,
    capability.profession_taxonomy_release_id,
    capability.profession_code, capability.proposed_by_user_id,
    capability.proposed_at, capability.confirmed_by_user_id,
    capability.confirmed_at
  FROM verified_completed_job_capabilities capability
  WHERE capability.job_id = NEW.job_id
    AND capability.participant_id = NEW.target_participant_id
    AND capability.kind = 'PROFESSION';

  INSERT INTO job_supervisor_evaluation_role_snapshots (
    evaluation_id, source_role_id, role, role_started_at, role_ended_at,
    assignment_event_id, role_decision_id, role_confirmed_at
  )
  SELECT NEW.evaluation_id,
    coalesce(role_evidence.assignment_event_id,
      role_evidence.participant_id),
    role_evidence.role, role_evidence.role_started_at,
    role_evidence.role_ended_at, role_evidence.assignment_event_id,
    role_evidence.role_decision_id, role_evidence.role_confirmed_at
  FROM verified_completed_job_roles role_evidence
  WHERE role_evidence.job_id = NEW.job_id
    AND role_evidence.participant_id = NEW.target_participant_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_supervisor_evaluation_snapshot_provenance
AFTER INSERT ON job_supervisor_evaluations
FOR EACH ROW EXECUTE FUNCTION snapshot_job_supervisor_evaluation_provenance();

CREATE FUNCTION validate_job_supervisor_evaluation_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evaluation job_supervisor_evaluations%ROWTYPE;
  prior_command job_supervisor_evaluation_revisions%ROWTYPE;
  expected_keys text[] := ARRAY[
    'competence_quality', 'reliability', 'independence', 'productivity',
    'collaboration', 'problem_solving', 'would_take_into_crew_again'
  ];
  actual_count integer;
  first_at timestamptz;
  latest_version integer;
  now_at timestamptz;
BEGIN
  SELECT * INTO evaluation FROM job_supervisor_evaluations
  WHERE evaluation_id = NEW.evaluation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'supervisor evaluation required'; END IF;
  PERFORM 1 FROM jobs WHERE id = evaluation.job_id FOR UPDATE;
  SELECT * INTO evaluation FROM job_supervisor_evaluations
  WHERE evaluation_id = NEW.evaluation_id FOR UPDATE;
  SELECT * INTO prior_command FROM job_supervisor_evaluation_revisions
  WHERE event_id = NEW.event_id;
  IF FOUND THEN
    IF prior_command.evaluation_id IS NOT DISTINCT FROM NEW.evaluation_id
      AND prior_command.version IS NOT DISTINCT FROM NEW.version
      AND prior_command.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
      AND prior_command.ratings IS NOT DISTINCT FROM NEW.ratings
      AND prior_command.comment IS NOT DISTINCT FROM NEW.comment THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'supervisor evaluation event identifier reuse conflict';
  END IF;
  IF NEW.actor_user_id IS DISTINCT FROM evaluation.evaluator_user_id THEN
    RAISE EXCEPTION 'supervisor evaluation author required';
  END IF;
  PERFORM 1 FROM users actor
  JOIN auth_credentials credential ON credential.user_id = actor.id
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN RAISE EXCEPTION 'active verified supervisor required'; END IF;

  SELECT count(*) INTO actual_count FROM jsonb_object_keys(NEW.ratings);
  IF actual_count <> cardinality(expected_keys)
    OR EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.ratings) item(key)
      WHERE NOT item.key = ANY(expected_keys)
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_each(NEW.ratings) item(key, value)
      WHERE item.value <> 'null'::jsonb
        AND item.value::text NOT IN ('1', '2', '3', '4', '5')
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_each(NEW.ratings) item(key, value)
      WHERE item.value::text IN ('1', '2', '3', '4', '5')
    ) THEN
    RAISE EXCEPTION 'exact substantive supervisor ratings required';
  END IF;
  IF NEW.comment IS NOT NULL AND (
    NEW.comment <> btrim(NEW.comment)
    OR length(NEW.comment) < 1 OR length(NEW.comment) > 2000
    OR NEW.comment ~ '[[:cntrl:]]'
  ) THEN RAISE EXCEPTION 'invalid supervisor evaluation comment'; END IF;

  now_at := clock_timestamp();
  IF now_at >= evaluation.submission_deadline THEN
    RAISE EXCEPTION 'ordinary supervisor evaluation window closed';
  END IF;
  SELECT min(recorded_at), max(version) INTO first_at, latest_version
  FROM job_supervisor_evaluation_revisions
  WHERE evaluation_id = NEW.evaluation_id;
  IF first_at IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first supervisor evaluation revision required';
    END IF;
  ELSIF NEW.version <> latest_version + 1
      OR now_at >= least(first_at + interval '60 minutes',
        evaluation.submission_deadline) THEN
    RAISE EXCEPTION 'supervisor evaluation edit window closed or stale';
  END IF;
  NEW.recorded_at := now_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_supervisor_evaluation_revision_validate
BEFORE INSERT ON job_supervisor_evaluation_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_supervisor_evaluation_revision();

CREATE FUNCTION require_initial_job_supervisor_evaluation_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_supervisor_evaluation_revisions revision
    WHERE revision.evaluation_id = NEW.evaluation_id
      AND revision.version = 1
  ) THEN RAISE EXCEPTION 'supervisor evaluation requires initial revision'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER job_supervisor_evaluation_initial_revision
AFTER INSERT ON job_supervisor_evaluations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  require_initial_job_supervisor_evaluation_revision();

CREATE FUNCTION reject_job_supervisor_evaluation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job supervisor evaluation history is immutable'; END;
$$;
CREATE TRIGGER job_supervisor_evaluation_immutable
BEFORE UPDATE OR DELETE ON job_supervisor_evaluations
FOR EACH ROW EXECUTE FUNCTION reject_job_supervisor_evaluation_mutation();
CREATE TRIGGER job_supervisor_evaluation_revision_immutable
BEFORE UPDATE OR DELETE ON job_supervisor_evaluation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_supervisor_evaluation_mutation();
CREATE TRIGGER job_supervisor_profession_snapshot_immutable
BEFORE UPDATE OR DELETE ON job_supervisor_evaluation_profession_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_supervisor_evaluation_mutation();
CREATE TRIGGER job_supervisor_role_snapshot_immutable
BEFORE UPDATE OR DELETE ON job_supervisor_evaluation_role_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_supervisor_evaluation_mutation();

CREATE VIEW current_job_supervisor_evaluations
WITH (security_invoker = true)
AS
WITH firsts AS (
  SELECT evaluation_id, recorded_at AS submitted_at
  FROM job_supervisor_evaluation_revisions WHERE version = 1
), latest AS (
  SELECT DISTINCT ON (evaluation_id) evaluation_id,
    event_id AS revision_id, version, ratings, comment,
    recorded_at AS revised_at
  FROM job_supervisor_evaluation_revisions
  ORDER BY evaluation_id, version DESC
)
SELECT evaluation.evaluation_id, evaluation.job_id,
  evaluation.target_participant_id, evaluation.target_profile_id,
  evaluation.evaluator_user_id, evaluation.relationship_kind,
  evaluation.evaluator_participant_id,
  evaluation.evaluator_role_assignment_event_id,
  evaluation.shared_work_group_id, evaluation.overlap_started_at,
  evaluation.overlap_ended_at, evaluation.completion_decision_id,
  evaluation.completed_at, evaluation.submission_deadline,
  firsts.submitted_at,
  least(firsts.submitted_at + interval '60 minutes',
    evaluation.submission_deadline) AS edit_deadline,
  latest.revision_id, latest.version, latest.ratings,
  latest.comment, latest.revised_at,
  'SUPERVISOR_EVALUATION'::text AS source_type
FROM job_supervisor_evaluations evaluation
JOIN firsts ON firsts.evaluation_id = evaluation.evaluation_id
JOIN latest ON latest.evaluation_id = evaluation.evaluation_id;

CREATE FUNCTION emit_job_supervisor_evaluation_notification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evaluation job_supervisor_evaluations%ROWTYPE;
DECLARE recipient_id uuid;
BEGIN
  IF NEW.version <> 1 THEN RETURN NULL; END IF;
  SELECT candidate.* INTO evaluation
  FROM job_supervisor_evaluations candidate
  WHERE candidate.evaluation_id = NEW.evaluation_id;
  SELECT target.owner_user_id INTO recipient_id
  FROM craftsman_profiles target
  WHERE target.id = evaluation.target_profile_id;
  IF evaluation.evaluation_id IS NULL OR recipient_id IS NULL
      OR recipient_id = evaluation.evaluator_user_id THEN
    RAISE EXCEPTION 'supervisor evaluation notification provenance missing';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job:' || evaluation.job_id::text || ':supervisor-evaluation:'
      || evaluation.evaluation_id::text || ':visible',
    'job.review.supervisor.visible', NEW.recorded_at,
    'SUPERVISOR_EVALUATION', evaluation.evaluation_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'job_id', evaluation.job_id::text,
      'evaluation_id', evaluation.evaluation_id::text
    ),
    'job.review.supervisor.visible', evaluation.evaluation_id::text,
    NEW.recorded_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_supervisor_evaluation_notification_capture
AFTER INSERT ON job_supervisor_evaluation_revisions
FOR EACH ROW EXECUTE FUNCTION emit_job_supervisor_evaluation_notification();

-- Only stable, edit-locked evidence contributes to public-safe counts. The
-- projection intentionally contains no Job, evaluator, rating or comment.
CREATE VIEW current_locked_supervisor_evaluation_professions
WITH (security_invoker = true)
AS
SELECT DISTINCT evaluation.evaluation_id,
  evaluation.target_profile_id AS craftsman_profile_id,
  profession.profession_code
FROM current_job_supervisor_evaluations evaluation
JOIN job_supervisor_evaluation_profession_snapshots profession
  ON profession.evaluation_id = evaluation.evaluation_id
WHERE clock_timestamp() >= evaluation.edit_deadline;

CREATE OR REPLACE VIEW current_searchable_trust_evidence_summaries
WITH (security_invoker = true)
AS
SELECT searchable.craftsman_profile_id,
  COALESCE(customer_reputation.review_count, 0)::integer
    AS customer_review_count,
  COALESCE(supervisor_reputation.evaluation_count, 0)::integer
    AS supervisor_evaluation_count,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profile_evidence completed
    WHERE completed.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS verified_job_count,
  ((CASE WHEN COALESCE(customer_reputation.review_count, 0) > 0
      THEN 1 ELSE 0 END)
    + (CASE WHEN COALESCE(supervisor_reputation.evaluation_count, 0) > 0
      THEN 1 ELSE 0 END))::integer AS independent_evidence_source_count,
  (
    SELECT count(DISTINCT credential.credential_type_code)::integer
    FROM current_searchable_craftsman_credentials credential
    WHERE credential.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS approved_credential_type_count,
  (
    SELECT count(DISTINCT project.portfolio_project_id)::integer
    FROM current_public_portfolio_projects project
    WHERE project.craftsman_profile_id = searchable.craftsman_profile_id
      AND project.evidence_status = 'VERIFIED'
  ) AS verified_portfolio_project_count,
  customer_reputation.customer_score,
  COALESCE(customer_reputation.review_count, 0) > 0
    AS customer_quality_available,
  false AS supervisor_quality_available,
  'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence,
  'INSUFFICIENT_SAMPLE'::text AS supervisor_evidence_confidence,
  'INSUFFICIENT_SAMPLE'::text AS source_diversity_confidence
FROM current_searchable_craftsman_profiles searchable
LEFT JOIN LATERAL (
  SELECT round(avg(review.review_score), 2)::numeric AS customer_score,
    count(*)::integer AS review_count
  FROM current_unlocked_provider_main_review_scores review
  WHERE review.craftsman_profile_id = searchable.craftsman_profile_id
) customer_reputation ON true
LEFT JOIN LATERAL (
  SELECT count(DISTINCT evaluation.evaluation_id)::integer
    AS evaluation_count
  FROM current_locked_supervisor_evaluation_professions evaluation
  WHERE evaluation.craftsman_profile_id = searchable.craftsman_profile_id
) supervisor_reputation ON true;

CREATE OR REPLACE VIEW current_searchable_profession_trust_evidence
WITH (security_invoker = true)
AS
SELECT profession.craftsman_profile_id, profession.profession_code,
  profession.evidence_supported_level,
  EXISTS (
    SELECT 1 FROM current_searchable_craftsman_specializations specialization
    WHERE specialization.craftsman_profile_id = profession.craftsman_profile_id
      AND specialization.profession_code = profession.profession_code
      AND specialization.evidence_supported
  ) AS has_evidence_supported_specialization,
  EXISTS (
    SELECT 1 FROM current_searchable_craftsman_skills skill
    WHERE skill.craftsman_profile_id = profession.craftsman_profile_id
      AND profession.profession_code = ANY(skill.profession_codes)
      AND skill.evidence_supported
  ) AS has_evidence_supported_skill,
  COALESCE(customer_reputation.review_count, 0)::integer
    AS customer_review_count,
  COALESCE(supervisor_reputation.evaluation_count, 0)::integer
    AS supervisor_evaluation_count,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profession_evidence completed
    WHERE completed.craftsman_profile_id = profession.craftsman_profile_id
      AND completed.profession_code = profession.profession_code
  ) AS verified_job_count,
  ((CASE WHEN COALESCE(customer_reputation.review_count, 0) > 0
      THEN 1 ELSE 0 END)
    + (CASE WHEN COALESCE(supervisor_reputation.evaluation_count, 0) > 0
      THEN 1 ELSE 0 END))::integer AS independent_evidence_source_count,
  (
    SELECT count(DISTINCT credential.credential_type_code)::integer
    FROM current_searchable_craftsman_credentials credential
    WHERE credential.craftsman_profile_id = profession.craftsman_profile_id
      AND credential.profession_code = profession.profession_code
  ) AS approved_credential_type_count,
  (
    SELECT count(DISTINCT public_project.portfolio_project_id)::integer
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project
      ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_professions project_profession
      ON project_profession.id = ANY(project.profession_ids)
      AND project_profession.craftsman_profile_id = profession.craftsman_profile_id
      AND project_profession.profession_code = profession.profession_code
      AND project_profession.state = 'ACTIVE'
    WHERE public_project.craftsman_profile_id = profession.craftsman_profile_id
      AND public_project.evidence_status = 'VERIFIED'
  ) AS verified_portfolio_project_count,
  customer_reputation.customer_score,
  COALESCE(customer_reputation.review_count, 0) > 0
    AS customer_quality_available,
  false AS supervisor_quality_available,
  'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence,
  'INSUFFICIENT_SAMPLE'::text AS supervisor_evidence_confidence,
  'INSUFFICIENT_SAMPLE'::text AS source_diversity_confidence
FROM current_searchable_craftsman_professions profession
LEFT JOIN LATERAL (
  SELECT round(avg(review.review_score), 2)::numeric AS customer_score,
    count(*)::integer AS review_count
  FROM current_unlocked_provider_main_review_scores review
  WHERE review.craftsman_profile_id = profession.craftsman_profile_id
    AND review.profession_code = profession.profession_code
) customer_reputation ON true
LEFT JOIN LATERAL (
  SELECT count(DISTINCT evaluation.evaluation_id)::integer
    AS evaluation_count
  FROM current_locked_supervisor_evaluation_professions evaluation
  WHERE evaluation.craftsman_profile_id = profession.craftsman_profile_id
    AND evaluation.profession_code = profession.profession_code
) supervisor_reputation ON true;

COMMENT ON VIEW job_supervisor_evaluation_relationships IS
  'Private exact supervisory relationships. Main contractor authority or confirmed operational role plus positive temporal/group overlap is required; same-Job presence alone is insufficient.';
COMMENT ON VIEW job_supervisor_evaluation_opportunities IS
  'Private deterministic post-completion supervisor rights with a Bratislava-local 14-calendar-day deadline and explicit relationship provenance.';
COMMENT ON TABLE job_supervisor_evaluations IS
  'Immutable logical supervisor evaluation identity tied to one evaluator, verified JobParticipant target, completed Job and exact supervisory overlap.';
COMMENT ON TABLE job_supervisor_evaluation_revisions IS
  'Immutable non-bilateral technical evaluation revisions. Ratings and comments must never enter logs, analytics, notifications or public projections.';
COMMENT ON VIEW current_job_supervisor_evaluations IS
  'Private latest raw supervisor evaluation; callers must restrict reads to evaluator, target or capability-gated admin.';
COMMENT ON VIEW current_locked_supervisor_evaluation_professions IS
  'Public-safe stable profession evidence volume source with no Job, evaluator, rating, comment or relationship disclosure.';
