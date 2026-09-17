-- A command replay must recover the same invitation identity, while a
-- participant with a pending or accepted interval cannot be invited twice.
ALTER TABLE job_participants
  ADD COLUMN invitation_command_id uuid UNIQUE;

CREATE FUNCTION reject_duplicate_current_job_participant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize invitations and cancellation with the same Job-row lock as
  -- the identity validator, independent of BEFORE-trigger ordering.
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM current_job_participants participant
    WHERE participant.job_id = NEW.job_id
      AND participant.craftsman_profile_id = NEW.craftsman_profile_id
      AND participant.state IN ('INVITED', 'ACCEPTED')
  ) THEN
    RAISE EXCEPTION 'current Job participant invitation already exists';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_participant_no_duplicate_current
BEFORE INSERT ON job_participants
FOR EACH ROW EXECUTE FUNCTION reject_duplicate_current_job_participant();
