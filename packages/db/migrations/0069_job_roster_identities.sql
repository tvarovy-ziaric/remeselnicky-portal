-- R4-008 identity foundation. An invitation identity is not verified work.
-- R4-009 adds acceptance/departure and group-composition event history.
CREATE TABLE crews (
  id uuid PRIMARY KEY,
  founder_craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (
    name = btrim(name) AND length(name) BETWEEN 2 AND 120
    AND name !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, founder_craftsman_profile_id)
);

CREATE INDEX crews_founder_idx
  ON crews (founder_craftsman_profile_id, created_at DESC, id);

CREATE TABLE job_participants (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  invitation_sequence integer NOT NULL CHECK (invitation_sequence > 0),
  invited_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, craftsman_profile_id, invitation_sequence),
  UNIQUE (job_id, id)
);

CREATE INDEX job_participants_job_time_idx
  ON job_participants (job_id, invited_at DESC, id);
CREATE INDEX job_participants_profile_time_idx
  ON job_participants (craftsman_profile_id, invited_at DESC, id);

CREATE TABLE job_work_groups (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  crew_id uuid REFERENCES crews(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (
    name = btrim(name) AND length(name) BETWEEN 2 AND 120
    AND name !~ '[[:cntrl:]]'
  ),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, id)
);

CREATE INDEX job_work_groups_job_time_idx
  ON job_work_groups (job_id, created_at DESC, id);
CREATE INDEX job_work_groups_crew_idx
  ON job_work_groups (crew_id, job_id) WHERE crew_id IS NOT NULL;

CREATE FUNCTION validate_crew_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM craftsman_profiles profile
  JOIN users actor ON actor.id = profile.owner_user_id
  WHERE profile.id = NEW.founder_craftsman_profile_id
    AND actor.id = NEW.created_by_user_id
    AND actor.account_state = 'ACTIVE'
  FOR SHARE OF profile, actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Crew founder required';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER crew_identity_validate
BEFORE INSERT ON crews
FOR EACH ROW EXECUTE FUNCTION validate_crew_identity();

CREATE FUNCTION validate_job_participant_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_sequence integer;
BEGIN
  -- The Job row serializes concurrent invitations and cancellation.
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmed Job required';
  END IF;
  PERFORM 1
  FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN craftsman_profiles primary_provider
    ON primary_provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = primary_provider.owner_user_id
  JOIN craftsman_profiles participant
    ON participant.id = NEW.craftsman_profile_id
  JOIN users participant_owner
    ON participant_owner.id = participant.owner_user_id
  WHERE job.id = NEW.job_id
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
    AND actor.id = NEW.invited_by_user_id
    AND actor.account_state = 'ACTIVE'
    AND participant.profile_type = 'INDIVIDUAL'
    AND participant_owner.account_state = 'ACTIVE'
  FOR SHARE OF actor, participant, participant_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible Job participation invitation required';
  END IF;
  SELECT coalesce(max(invitation_sequence), 0) + 1
    INTO expected_sequence
  FROM job_participants
  WHERE job_id = NEW.job_id
    AND craftsman_profile_id = NEW.craftsman_profile_id;
  IF NEW.invitation_sequence <> expected_sequence THEN
    RAISE EXCEPTION 'next participation invitation sequence required';
  END IF;
  NEW.invited_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_participant_identity_validate
BEFORE INSERT ON job_participants
FOR EACH ROW EXECUTE FUNCTION validate_job_participant_identity();

CREATE FUNCTION validate_job_work_group_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmed Job required';
  END IF;
  PERFORM 1
  FROM jobs job
  JOIN current_job_states state ON state.job_id = job.id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN craftsman_profiles primary_provider
    ON primary_provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = primary_provider.owner_user_id
  WHERE job.id = NEW.job_id
    AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
    AND actor.id = NEW.created_by_user_id
    AND actor.account_state = 'ACTIVE'
    AND (NEW.crew_id IS NULL OR EXISTS (
      SELECT 1 FROM crews crew
      WHERE crew.id = NEW.crew_id
        AND crew.founder_craftsman_profile_id = primary_provider.id
    ))
  FOR SHARE OF actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'eligible Job work-group creator required';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_work_group_identity_validate
BEFORE INSERT ON job_work_groups
FOR EACH ROW EXECUTE FUNCTION validate_job_work_group_identity();

CREATE FUNCTION reject_job_roster_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job roster identities are immutable';
END;
$$;

CREATE TRIGGER crew_identity_immutable
BEFORE UPDATE OR DELETE ON crews
FOR EACH ROW EXECUTE FUNCTION reject_job_roster_identity_mutation();
CREATE TRIGGER job_participant_identity_immutable
BEFORE UPDATE OR DELETE ON job_participants
FOR EACH ROW EXECUTE FUNCTION reject_job_roster_identity_mutation();
CREATE TRIGGER job_work_group_identity_immutable
BEFORE UPDATE OR DELETE ON job_work_groups
FOR EACH ROW EXECUTE FUNCTION reject_job_roster_identity_mutation();

COMMENT ON TABLE job_participants IS
  'One invited participation interval; not verified evidence until an explicit R4-009 acceptance event.';
COMMENT ON TABLE job_work_groups IS
  'Concrete Job group identity. A Crew reference never imports standing members or proves Job participation.';
