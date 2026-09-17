-- MEMBER is the implicit job-specific role of every accepted participant.
-- Additional, overlapping operational roles use append-only assignment events.
CREATE TYPE job_participant_operational_role AS ENUM (
  'LEAD', 'COORDINATOR', 'SITE_MANAGER'
);
CREATE TYPE job_participant_role_action AS ENUM ('ASSIGN', 'REVOKE');

CREATE TABLE job_participant_role_events (
  event_id uuid PRIMARY KEY,
  participant_id uuid NOT NULL
    REFERENCES job_participants(id) ON DELETE RESTRICT,
  role job_participant_operational_role NOT NULL,
  role_sequence integer NOT NULL CHECK (role_sequence > 0),
  action job_participant_role_action NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (participant_id, role, role_sequence)
);

CREATE INDEX job_participant_role_events_time_idx
  ON job_participant_role_events
    (participant_id, role, role_sequence DESC);

CREATE VIEW job_participant_role_intervals AS
SELECT participant.id AS participant_id, 'MEMBER'::text AS role,
  participant.accepted_at AS assigned_at,
  least(participant.left_at, state.cancelled_at) AS ended_at,
  (participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')) AS active,
  NULL::uuid AS assignment_event_id
FROM current_job_participants participant
JOIN current_job_states state ON state.job_id = participant.job_id
WHERE participant.accepted_at IS NOT NULL
UNION ALL
SELECT assignment.participant_id, assignment.role::text AS role,
  assignment.recorded_at AS assigned_at,
  least(revocation.recorded_at, participant.left_at,
    state.cancelled_at) AS ended_at,
  (revocation.event_id IS NULL
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')) AS active,
  assignment.event_id AS assignment_event_id
FROM job_participant_role_events assignment
JOIN current_job_participants participant
  ON participant.id = assignment.participant_id
JOIN current_job_states state ON state.job_id = participant.job_id
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

CREATE FUNCTION validate_job_participant_role_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  prior_action job_participant_role_action;
  expected_sequence integer;
BEGIN
  SELECT job_id INTO target_job_id
  FROM job_participants WHERE id = NEW.participant_id;
  IF target_job_id IS NULL THEN
    RAISE EXCEPTION 'Job participant required';
  END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM job_participants
    WHERE id = NEW.participant_id FOR UPDATE;
  PERFORM 1
  FROM current_job_participants participant
  JOIN jobs job ON job.id = participant.job_id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN craftsman_profiles primary_provider
    ON primary_provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = primary_provider.owner_user_id
  WHERE participant.id = NEW.participant_id
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
    AND actor.id = NEW.actor_user_id
    AND actor.account_state = 'ACTIVE'
  FOR SHARE OF actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active accepted participant and primary provider required';
  END IF;
  SELECT action INTO prior_action
  FROM job_participant_role_events
  WHERE participant_id = NEW.participant_id AND role = NEW.role
  ORDER BY role_sequence DESC LIMIT 1;
  SELECT coalesce(max(role_sequence), 0) + 1 INTO expected_sequence
  FROM job_participant_role_events
  WHERE participant_id = NEW.participant_id AND role = NEW.role;
  IF NEW.role_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'next Job participant role sequence required';
  END IF;
  IF (NEW.action = 'ASSIGN' AND prior_action = 'ASSIGN')
      OR (NEW.action = 'REVOKE'
        AND prior_action IS DISTINCT FROM 'ASSIGN') THEN
    RAISE EXCEPTION 'invalid Job participant role transition';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_participant_role_event_validate
BEFORE INSERT ON job_participant_role_events
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_role_event();

CREATE FUNCTION reject_job_participant_role_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job participant role events are immutable';
END;
$$;

CREATE TRIGGER job_participant_role_event_immutable
BEFORE UPDATE OR DELETE ON job_participant_role_events
FOR EACH ROW EXECUTE FUNCTION reject_job_participant_role_event_mutation();

COMMENT ON VIEW job_participant_role_intervals IS
  'Private historical Job-specific roles; MEMBER derives from explicit acceptance, while additional roles retain assignment/revocation history.';
