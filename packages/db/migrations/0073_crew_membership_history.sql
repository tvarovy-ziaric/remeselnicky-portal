-- A reusable Crew relationship needs its own acceptance. It never creates
-- JobParticipant evidence or imports a person into a JobWorkGroup.
CREATE TABLE crew_membership_invitations (
  id uuid PRIMARY KEY,
  crew_id uuid NOT NULL REFERENCES crews(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  invitation_sequence integer NOT NULL CHECK (invitation_sequence > 0),
  invited_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (crew_id, craftsman_profile_id, invitation_sequence)
);

CREATE INDEX crew_membership_invitations_crew_time_idx
  ON crew_membership_invitations (crew_id, invited_at DESC, id);
CREATE INDEX crew_membership_invitations_profile_time_idx
  ON crew_membership_invitations
    (craftsman_profile_id, invited_at DESC, id);

CREATE TYPE crew_membership_event_kind AS ENUM (
  'ACCEPT', 'DECLINE', 'LEAVE', 'REMOVE'
);

CREATE TABLE crew_membership_events (
  event_id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL
    REFERENCES crew_membership_invitations(id) ON DELETE RESTRICT,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  event_kind crew_membership_event_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (invitation_id, event_sequence),
  CONSTRAINT crew_membership_event_reason CHECK (
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

CREATE INDEX crew_membership_events_time_idx
  ON crew_membership_events (invitation_id, event_sequence DESC);

CREATE VIEW current_crew_memberships AS
SELECT invitation.id, invitation.crew_id,
  invitation.craftsman_profile_id, invitation.invitation_sequence,
  invitation.invited_by_user_id, invitation.invited_at,
  CASE
    WHEN latest.event_kind = 'ACCEPT' THEN 'ACCEPTED'
    WHEN latest.event_kind = 'DECLINE' THEN 'DECLINED'
    WHEN latest.event_kind = 'LEAVE' THEN 'LEFT'
    WHEN latest.event_kind = 'REMOVE' THEN 'REMOVED'
    ELSE 'INVITED'
  END AS state,
  accepted.recorded_at AS accepted_at,
  CASE WHEN latest.event_kind IN ('LEAVE', 'REMOVE')
    THEN latest.recorded_at ELSE NULL END AS left_at,
  latest.actor_user_id AS last_actor_user_id,
  coalesce(latest.event_kind = 'ACCEPT', false) AS active
FROM crew_membership_invitations invitation
LEFT JOIN LATERAL (
  SELECT event_kind, actor_user_id, recorded_at
  FROM crew_membership_events event
  WHERE event.invitation_id = invitation.id
  ORDER BY event.event_sequence DESC LIMIT 1
) latest ON true
LEFT JOIN crew_membership_events accepted
  ON accepted.invitation_id = invitation.id
  AND accepted.event_kind = 'ACCEPT';

CREATE FUNCTION validate_crew_membership_invitation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_sequence integer;
BEGIN
  PERFORM 1 FROM crews WHERE id = NEW.crew_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Crew required';
  END IF;
  PERFORM 1
  FROM crews crew
  JOIN craftsman_profiles founder
    ON founder.id = crew.founder_craftsman_profile_id
  JOIN users actor ON actor.id = founder.owner_user_id
  JOIN craftsman_profiles target
    ON target.id = NEW.craftsman_profile_id
  JOIN users target_owner ON target_owner.id = target.owner_user_id
  WHERE crew.id = NEW.crew_id
    AND actor.id = NEW.invited_by_user_id
    AND actor.account_state = 'ACTIVE'
    AND target.profile_type = 'INDIVIDUAL'
    AND target_owner.account_state = 'ACTIVE'
  FOR SHARE OF actor, target, target_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Crew founder and individual invitee required';
  END IF;
  SELECT coalesce(max(invitation_sequence), 0) + 1
    INTO expected_sequence
  FROM crew_membership_invitations
  WHERE crew_id = NEW.crew_id
    AND craftsman_profile_id = NEW.craftsman_profile_id;
  IF NEW.invitation_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'next Crew invitation sequence required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM current_crew_memberships membership
    WHERE membership.crew_id = NEW.crew_id
      AND membership.craftsman_profile_id = NEW.craftsman_profile_id
      AND membership.state IN ('INVITED', 'ACCEPTED')
  ) THEN
    RAISE EXCEPTION 'active Crew membership invitation already exists';
  END IF;
  NEW.invited_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER crew_membership_invitation_validate
BEFORE INSERT ON crew_membership_invitations
FOR EACH ROW EXECUTE FUNCTION validate_crew_membership_invitation();

CREATE FUNCTION validate_crew_membership_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_crew_id uuid;
  target_user_id uuid;
  founder_user_id uuid;
  prior_event_kind crew_membership_event_kind;
  expected_sequence integer;
BEGIN
  SELECT crew_id INTO target_crew_id
  FROM crew_membership_invitations WHERE id = NEW.invitation_id;
  IF target_crew_id IS NULL THEN
    RAISE EXCEPTION 'Crew membership invitation required';
  END IF;
  PERFORM 1 FROM crews WHERE id = target_crew_id FOR UPDATE;
  PERFORM 1 FROM crew_membership_invitations
    WHERE id = NEW.invitation_id FOR UPDATE;
  SELECT target.owner_user_id, founder.owner_user_id
    INTO target_user_id, founder_user_id
  FROM crew_membership_invitations invitation
  JOIN crews crew ON crew.id = invitation.crew_id
  JOIN craftsman_profiles target
    ON target.id = invitation.craftsman_profile_id
  JOIN craftsman_profiles founder
    ON founder.id = crew.founder_craftsman_profile_id
  JOIN users actor ON actor.id = NEW.actor_user_id
  WHERE invitation.id = NEW.invitation_id
    AND actor.account_state = 'ACTIVE';
  IF target_user_id IS NULL OR founder_user_id IS NULL THEN
    RAISE EXCEPTION 'active Crew membership actor required';
  END IF;
  SELECT event_kind INTO prior_event_kind
  FROM crew_membership_events
  WHERE invitation_id = NEW.invitation_id
  ORDER BY event_sequence DESC LIMIT 1;
  SELECT coalesce(max(event_sequence), 0) + 1 INTO expected_sequence
  FROM crew_membership_events
  WHERE invitation_id = NEW.invitation_id;
  IF NEW.event_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'next Crew membership event sequence required';
  END IF;
  IF NEW.event_kind IN ('ACCEPT', 'DECLINE') THEN
    IF prior_event_kind IS NOT NULL
        OR NEW.actor_user_id <> target_user_id THEN
      RAISE EXCEPTION 'invitee must decide pending Crew membership';
    END IF;
  ELSIF NEW.event_kind = 'LEAVE' THEN
    IF prior_event_kind IS DISTINCT FROM 'ACCEPT'
        OR NEW.actor_user_id <> target_user_id THEN
      RAISE EXCEPTION 'accepted Crew member must leave';
    END IF;
  ELSE
    IF prior_event_kind IS DISTINCT FROM 'ACCEPT'
        OR NEW.actor_user_id <> founder_user_id THEN
      RAISE EXCEPTION 'Crew founder must remove accepted member';
    END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER crew_membership_event_validate
BEFORE INSERT ON crew_membership_events
FOR EACH ROW EXECUTE FUNCTION validate_crew_membership_event();

CREATE FUNCTION reject_crew_membership_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Crew membership history is immutable';
END;
$$;

CREATE TRIGGER crew_membership_invitation_immutable
BEFORE UPDATE OR DELETE ON crew_membership_invitations
FOR EACH ROW EXECUTE FUNCTION reject_crew_membership_mutation();
CREATE TRIGGER crew_membership_event_immutable
BEFORE UPDATE OR DELETE ON crew_membership_events
FOR EACH ROW EXECUTE FUNCTION reject_crew_membership_mutation();

COMMENT ON VIEW current_crew_memberships IS
  'Private reusable Crew membership state requiring invitee acceptance; it conveys no Job participation or group assignment.';
