-- R4-016: provider-assigned operational roles remain contextual until the
-- actual participant confirms them. A correction request preserves the claim.
CREATE TYPE job_participant_role_decision_kind AS ENUM (
  'CONFIRM', 'REQUEST_CORRECTION'
);

CREATE TABLE job_participant_role_decisions (
  decision_id uuid PRIMARY KEY,
  assignment_event_id uuid NOT NULL UNIQUE
    REFERENCES job_participant_role_events(event_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision_kind job_participant_role_decision_kind NOT NULL,
  reason text,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_participant_role_decision_shape CHECK (
    (decision_kind = 'CONFIRM' AND reason IS NULL)
    OR (decision_kind = 'REQUEST_CORRECTION' AND reason IS NOT NULL
      AND reason = btrim(reason) AND length(reason) BETWEEN 8 AND 500
      AND reason !~ '[[:cntrl:]]')
  )
);

-- The pre-existing role timeline remains historical but now derives its
-- effective end from completion as well as revocation, departure or cancel.
CREATE OR REPLACE VIEW job_participant_role_intervals AS
SELECT participant.id AS participant_id, 'MEMBER'::text AS role,
  participant.accepted_at AS assigned_at,
  least(participant.left_at, state.cancelled_at, evidence.completed_at)
    AS ended_at,
  (participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')) AS active,
  NULL::uuid AS assignment_event_id
FROM current_job_participants participant
JOIN current_job_states state ON state.job_id = participant.job_id
LEFT JOIN completed_job_evidence_provenance evidence
  ON evidence.job_id = participant.job_id
WHERE participant.accepted_at IS NOT NULL
UNION ALL
SELECT assignment.participant_id, assignment.role::text AS role,
  assignment.recorded_at AS assigned_at,
  least(revocation.recorded_at, participant.left_at,
    state.cancelled_at, evidence.completed_at) AS ended_at,
  (revocation.event_id IS NULL
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')) AS active,
  assignment.event_id AS assignment_event_id
FROM job_participant_role_events assignment
JOIN current_job_participants participant
  ON participant.id = assignment.participant_id
JOIN current_job_states state ON state.job_id = participant.job_id
LEFT JOIN completed_job_evidence_provenance evidence
  ON evidence.job_id = participant.job_id
LEFT JOIN LATERAL (
  SELECT event_id, recorded_at
  FROM job_participant_role_events event
  WHERE event.participant_id = assignment.participant_id
    AND event.role = assignment.role
    AND event.action = 'REVOKE'
    AND event.role_sequence > assignment.role_sequence
  ORDER BY event.role_sequence LIMIT 1
) revocation ON true
WHERE assignment.action = 'ASSIGN';

CREATE FUNCTION validate_job_participant_role_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; assignment_actor_id uuid;
BEGIN
  SELECT participant.job_id, assignment.actor_user_id
    INTO target_job_id, assignment_actor_id
  FROM job_participant_role_events assignment
  JOIN job_participants participant ON participant.id = assignment.participant_id
  WHERE assignment.event_id = NEW.assignment_event_id
    AND assignment.action = 'ASSIGN';
  IF target_job_id IS NULL THEN
    RAISE EXCEPTION 'role assignment required';
  END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM job_participant_role_events
    WHERE event_id = NEW.assignment_event_id FOR UPDATE;
  PERFORM 1
  FROM job_participant_role_events assignment
  JOIN current_job_participants participant
    ON participant.id = assignment.participant_id
  JOIN job_participant_role_intervals role_interval
    ON role_interval.assignment_event_id = assignment.event_id
  JOIN craftsman_profiles profile
    ON profile.id = participant.craftsman_profile_id
  JOIN users actor ON actor.id = NEW.actor_user_id
    AND actor.id = profile.owner_user_id
    AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials credential ON credential.user_id = actor.id
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  WHERE assignment.event_id = NEW.assignment_event_id
    AND participant.state = 'ACCEPTED'
    AND role_interval.active
  FOR SHARE OF actor, credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active assigned role and participant confirmation required';
  END IF;
  IF NEW.decision_kind = 'CONFIRM'
    AND assignment_actor_id = NEW.actor_user_id THEN
    RAISE EXCEPTION 'participant cannot verify a self-assigned role';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_participant_role_decision_validate
BEFORE INSERT ON job_participant_role_decisions
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_role_decision();

CREATE FUNCTION reject_job_participant_role_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job participant role decisions are immutable'; END;
$$;
CREATE TRIGGER job_participant_role_decision_immutable
BEFORE UPDATE OR DELETE ON job_participant_role_decisions
FOR EACH ROW EXECUTE FUNCTION reject_job_participant_role_decision_mutation();

CREATE VIEW verified_completed_job_roles
WITH (security_invoker = true)
AS
SELECT participation.job_id, participation.participant_id,
  participation.individual_profile_id,
  'MEMBER'::text AS role,
  participation.participation_started_at AS role_started_at,
  participation.participation_ended_at AS role_ended_at,
  NULL::uuid AS assignment_event_id,
  NULL::uuid AS role_decision_id,
  NULL::timestamptz AS role_confirmed_at,
  participation.completed_at, participation.completion_kind
FROM verified_individual_completed_job_participation participation
UNION ALL
SELECT participation.job_id, participation.participant_id,
  participation.individual_profile_id, role_interval.role,
  GREATEST(role_interval.assigned_at,
    participation.participation_started_at) AS role_started_at,
  LEAST(role_interval.ended_at,
    participation.participation_ended_at) AS role_ended_at,
  role_interval.assignment_event_id,
  decision.decision_id AS role_decision_id,
  decision.decided_at AS role_confirmed_at,
  participation.completed_at, participation.completion_kind
FROM verified_individual_completed_job_participation participation
JOIN job_participant_role_intervals role_interval
  ON role_interval.participant_id = participation.participant_id
  AND role_interval.assignment_event_id IS NOT NULL
JOIN job_participant_role_decisions decision
  ON decision.assignment_event_id = role_interval.assignment_event_id
  AND decision.decision_kind = 'CONFIRM'
  AND decision.decided_at <= participation.completed_at
WHERE role_interval.ended_at
  > GREATEST(role_interval.assigned_at,
    participation.participation_started_at);

COMMENT ON TABLE job_participant_role_decisions IS
  'Immutable participant confirmation or correction request for one exact operational-role assignment; provider assignment alone is not verified.';
COMMENT ON VIEW job_participant_role_intervals IS
  'Private historical Job-specific role intervals; completion closes active intervals without rewriting assignment or departure events.';
COMMENT ON VIEW verified_completed_job_roles IS
  'Private factual completed-Job role evidence: MEMBER from accepted execution participation; operational roles require the participant confirmation of that exact assignment.';
