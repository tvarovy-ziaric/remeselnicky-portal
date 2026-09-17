-- Concrete JobWorkGroup composition is independent of reusable Crew rosters.
-- Every assignment is a historical interval, including regrouping/rejoining.
CREATE TABLE job_work_group_assignments (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  work_group_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  assignment_sequence integer NOT NULL CHECK (assignment_sequence > 0),
  assigned_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id, work_group_id)
    REFERENCES job_work_groups(job_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, participant_id)
    REFERENCES job_participants(job_id, id) ON DELETE RESTRICT,
  UNIQUE (work_group_id, participant_id, assignment_sequence)
);

CREATE INDEX job_work_group_assignments_group_time_idx
  ON job_work_group_assignments (work_group_id, assigned_at DESC, id);
CREATE INDEX job_work_group_assignments_participant_idx
  ON job_work_group_assignments (participant_id, assigned_at DESC, id);

CREATE TYPE job_work_group_departure_kind AS ENUM ('LEAVE', 'REMOVE');

CREATE TABLE job_work_group_departure_events (
  event_id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL UNIQUE
    REFERENCES job_work_group_assignments(id) ON DELETE RESTRICT,
  event_kind job_work_group_departure_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_work_group_departure_reason CHECK (
    (reason IS NULL AND event_kind = 'LEAVE')
    OR (reason IS NOT NULL AND reason = btrim(reason)
      AND length(reason) BETWEEN 8 AND 500
      AND reason !~ '[[:cntrl:]]')
  )
);

CREATE VIEW current_job_work_group_assignments AS
SELECT assignment.id, assignment.job_id, assignment.work_group_id,
  assignment.participant_id, assignment.assignment_sequence,
  assignment.assigned_by_user_id, assignment.assigned_at,
  departure.event_id AS departure_event_id,
  departure.event_kind::text AS departure_kind,
  departure.actor_user_id AS departed_by_user_id,
  departure.reason AS departure_reason,
  least(departure.recorded_at, participant.left_at,
    state.cancelled_at) AS ended_at,
  (departure.event_id IS NULL
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')) AS active
FROM job_work_group_assignments assignment
JOIN current_job_participants participant
  ON participant.id = assignment.participant_id
JOIN current_job_states state ON state.job_id = assignment.job_id
LEFT JOIN job_work_group_departure_events departure
  ON departure.assignment_id = assignment.id;

CREATE FUNCTION validate_job_work_group_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_sequence integer;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmed Job required';
  END IF;
  PERFORM 1
  FROM job_work_groups group_row
  JOIN current_job_participants participant
    ON participant.job_id = group_row.job_id
  JOIN jobs job ON job.id = group_row.job_id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN craftsman_profiles primary_provider
    ON primary_provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = primary_provider.owner_user_id
  WHERE group_row.id = NEW.work_group_id
    AND group_row.job_id = NEW.job_id
    AND participant.id = NEW.participant_id
    AND participant.state = 'ACCEPTED'
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
    AND actor.id = NEW.assigned_by_user_id
    AND actor.account_state = 'ACTIVE'
  FOR SHARE OF actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted participant and primary provider required';
  END IF;
  SELECT coalesce(max(assignment_sequence), 0) + 1
    INTO expected_sequence
  FROM job_work_group_assignments
  WHERE work_group_id = NEW.work_group_id
    AND participant_id = NEW.participant_id;
  IF NEW.assignment_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'next work-group assignment sequence required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM current_job_work_group_assignments current_assignment
    WHERE current_assignment.work_group_id = NEW.work_group_id
      AND current_assignment.participant_id = NEW.participant_id
      AND current_assignment.active
  ) THEN
    RAISE EXCEPTION 'participant already active in this work group';
  END IF;
  NEW.assigned_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_work_group_assignment_validate
BEFORE INSERT ON job_work_group_assignments
FOR EACH ROW EXECUTE FUNCTION validate_job_work_group_assignment();

CREATE FUNCTION validate_job_work_group_departure()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  target_user_id uuid;
  primary_provider_user_id uuid;
BEGIN
  SELECT job_id INTO target_job_id
  FROM job_work_group_assignments WHERE id = NEW.assignment_id;
  IF target_job_id IS NULL THEN
    RAISE EXCEPTION 'work-group assignment required';
  END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM job_work_group_assignments
    WHERE id = NEW.assignment_id FOR UPDATE;
  SELECT participant_profile.owner_user_id,
    primary_provider.owner_user_id
    INTO target_user_id, primary_provider_user_id
  FROM job_work_group_assignments assignment
  JOIN job_participants participant
    ON participant.id = assignment.participant_id
  JOIN craftsman_profiles participant_profile
    ON participant_profile.id = participant.craftsman_profile_id
  JOIN jobs job ON job.id = assignment.job_id
  JOIN craftsman_profiles primary_provider
    ON primary_provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.actor_user_id
  WHERE assignment.id = NEW.assignment_id
    AND actor.account_state = 'ACTIVE';
  IF target_user_id IS NULL OR primary_provider_user_id IS NULL THEN
    RAISE EXCEPTION 'active work-group departure actor required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM current_job_work_group_assignments current_assignment
    WHERE current_assignment.id = NEW.assignment_id
      AND current_assignment.active
  ) THEN
    RAISE EXCEPTION 'active work-group assignment required';
  END IF;
  IF (NEW.event_kind = 'LEAVE'
        AND NEW.actor_user_id <> target_user_id)
      OR (NEW.event_kind = 'REMOVE'
        AND NEW.actor_user_id <> primary_provider_user_id) THEN
    RAISE EXCEPTION 'work-group departure actor not authorized';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_work_group_departure_validate
BEFORE INSERT ON job_work_group_departure_events
FOR EACH ROW EXECUTE FUNCTION validate_job_work_group_departure();

CREATE FUNCTION reject_job_work_group_composition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job work-group composition is immutable';
END;
$$;

CREATE TRIGGER job_work_group_assignment_immutable
BEFORE UPDATE OR DELETE ON job_work_group_assignments
FOR EACH ROW EXECUTE FUNCTION reject_job_work_group_composition_mutation();
CREATE TRIGGER job_work_group_departure_immutable
BEFORE UPDATE OR DELETE ON job_work_group_departure_events
FOR EACH ROW EXECUTE FUNCTION reject_job_work_group_composition_mutation();

COMMENT ON VIEW current_job_work_group_assignments IS
  'Private derived concrete Job group composition. A Crew link does not add any member; callers must authorize Job-scoped reads.';
