-- An invitation identity alone never represents accepted/verified work.
CREATE TYPE job_participant_event_kind AS ENUM (
  'ACCEPT', 'DECLINE', 'LEAVE', 'REMOVE'
);

CREATE TABLE job_participant_events (
  event_id uuid PRIMARY KEY,
  participant_id uuid NOT NULL
    REFERENCES job_participants(id) ON DELETE RESTRICT,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  event_kind job_participant_event_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (participant_id, event_sequence),
  CONSTRAINT job_participant_event_reason CHECK (
    (event_kind IN ('ACCEPT', 'DECLINE') AND reason IS NULL)
    OR (event_kind = 'LEAVE' AND (
      reason IS NULL OR (reason = btrim(reason)
        AND length(reason) BETWEEN 8 AND 500
        AND reason !~ '[[:cntrl:]]')
    ))
    OR (event_kind = 'REMOVE' AND reason IS NOT NULL
      AND reason = btrim(reason)
      AND length(reason) BETWEEN 8 AND 500
      AND reason !~ '[[:cntrl:]]')
  )
);

CREATE INDEX job_participant_events_time_idx
  ON job_participant_events (participant_id, event_sequence DESC);

CREATE VIEW current_job_participants AS
SELECT participant.id, participant.job_id, participant.craftsman_profile_id,
  participant.invitation_sequence, participant.invited_by_user_id,
  participant.invited_at,
  CASE
    WHEN latest.event_kind = 'ACCEPT' THEN 'ACCEPTED'
    WHEN latest.event_kind = 'DECLINE' THEN 'DECLINED'
    WHEN latest.event_kind = 'LEAVE' THEN 'LEFT'
    WHEN latest.event_kind = 'REMOVE' THEN 'REMOVED'
    ELSE 'INVITED'
  END AS state,
  accepted.recorded_at AS accepted_at,
  accepted.actor_user_id AS accepted_by_user_id,
  CASE WHEN latest.event_kind IN ('LEAVE', 'REMOVE')
    THEN latest.recorded_at ELSE NULL END AS left_at,
  CASE WHEN latest.event_kind IN ('LEAVE', 'REMOVE')
    THEN latest.actor_user_id ELSE NULL END AS ended_by_user_id,
  CASE WHEN latest.event_kind IN ('LEAVE', 'REMOVE')
    THEN latest.reason ELSE NULL END AS end_reason,
  accepted.event_id IS NOT NULL AS verified_participation
FROM job_participants participant
LEFT JOIN LATERAL (
  SELECT event_id, event_kind, actor_user_id, reason, recorded_at
  FROM job_participant_events event
  WHERE event.participant_id = participant.id
  ORDER BY event.event_sequence DESC LIMIT 1
) latest ON true
LEFT JOIN job_participant_events accepted
  ON accepted.participant_id = participant.id
  AND accepted.event_kind = 'ACCEPT';

CREATE FUNCTION validate_job_participant_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  target_owner_user_id uuid;
  primary_provider_user_id uuid;
  job_execution_state job_state;
  prior_event_kind job_participant_event_kind;
  expected_sequence integer;
BEGIN
  SELECT job_id INTO target_job_id
  FROM job_participants WHERE id = NEW.participant_id;
  IF target_job_id IS NULL THEN
    RAISE EXCEPTION 'Job participation invitation required';
  END IF;
  -- Match the Job -> participant lock order used by the invitation command.
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM 1 FROM job_participants
    WHERE id = NEW.participant_id FOR UPDATE;
  SELECT target.owner_user_id, primary_provider.owner_user_id,
    state.state
    INTO target_owner_user_id, primary_provider_user_id,
      job_execution_state
  FROM job_participants participant
  JOIN jobs job ON job.id = participant.job_id
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN craftsman_profiles target
    ON target.id = participant.craftsman_profile_id
  JOIN craftsman_profiles primary_provider
    ON primary_provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.actor_user_id
  WHERE participant.id = NEW.participant_id
    AND actor.account_state = 'ACTIVE';
  IF target_owner_user_id IS NULL OR primary_provider_user_id IS NULL THEN
    RAISE EXCEPTION 'active Job participation actor required';
  END IF;
  SELECT event_kind INTO prior_event_kind
  FROM job_participant_events
  WHERE participant_id = NEW.participant_id
  ORDER BY event_sequence DESC LIMIT 1;
  SELECT coalesce(max(event_sequence), 0) + 1 INTO expected_sequence
  FROM job_participant_events
  WHERE participant_id = NEW.participant_id;
  IF NEW.event_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'next Job participation event sequence required';
  END IF;
  IF NEW.event_kind IN ('ACCEPT', 'DECLINE') THEN
    IF prior_event_kind IS NOT NULL
        OR NEW.actor_user_id <> target_owner_user_id THEN
      RAISE EXCEPTION 'invitee must decide a pending participation';
    END IF;
    IF NEW.event_kind = 'ACCEPT'
        AND job_execution_state NOT IN ('CONFIRMED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'active Job required for participation acceptance';
    END IF;
  ELSIF NEW.event_kind = 'LEAVE' THEN
    IF prior_event_kind IS DISTINCT FROM 'ACCEPT'
        OR NEW.actor_user_id <> target_owner_user_id THEN
      RAISE EXCEPTION 'accepted participant must leave';
    END IF;
  ELSE
    IF prior_event_kind IS DISTINCT FROM 'ACCEPT'
        OR NEW.actor_user_id <> primary_provider_user_id THEN
      RAISE EXCEPTION 'primary provider must end accepted participation';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_participant_event_validate
BEFORE INSERT ON job_participant_events
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_event();

CREATE FUNCTION reject_job_participant_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job participation events are immutable';
END;
$$;

CREATE TRIGGER job_participant_event_immutable
BEFORE UPDATE OR DELETE ON job_participant_events
FOR EACH ROW EXECUTE FUNCTION reject_job_participant_event_mutation();

COMMENT ON VIEW current_job_participants IS
  'Private derived participation state. Only explicit target acceptance creates verified_participation; callers must authorize Job-scoped reads.';
