-- A participant notification is derived from an immutable invitation or
-- decision, never from a mutable roster projection. The outbox insert shares
-- the source transaction and its exact key is stable across command replays.
CREATE FUNCTION emit_job_participant_notification(
  source_key text,
  source_name text,
  source_at timestamptz,
  source_participant_id uuid,
  source_job_id uuid,
  source_recipient_id uuid,
  source_revision integer,
  source_command_id uuid
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF source_recipient_id IS NULL OR source_revision IS NULL
      OR source_revision < 1 THEN
    RAISE EXCEPTION 'Job participant notification provenance missing';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    source_key, source_name, source_at,
    'JOB_PARTICIPANT', source_participant_id::text,
    jsonb_build_object(
      'recipient_user_id', source_recipient_id::text,
      'job_id', source_job_id::text,
      'participant_id', source_participant_id::text,
      'participation_revision', source_revision
    ),
    'job_participant.' || split_part(source_name, '.', 2),
    source_command_id::text, source_at
  );
END;
$$;

CREATE FUNCTION notify_job_participant_invitation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
BEGIN
  SELECT profile.owner_user_id INTO recipient_id
  FROM craftsman_profiles profile
  WHERE profile.id = NEW.craftsman_profile_id;
  PERFORM emit_job_participant_notification(
    'job-participant:' || NEW.id::text || ':invited:invitee',
    'job_participant.invited', NEW.invited_at,
    NEW.id, NEW.job_id, recipient_id, NEW.invitation_sequence,
    coalesce(NEW.invitation_command_id, NEW.id)
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_participant_invitation_notify
AFTER INSERT ON job_participants
FOR EACH ROW EXECUTE FUNCTION notify_job_participant_invitation();

CREATE FUNCTION notify_job_participant_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  invitee_id uuid;
  provider_id uuid;
  customer_id uuid;
  source_key text;
BEGIN
  SELECT participant.job_id, invitee.owner_user_id,
    provider.owner_user_id, customer.owner_user_id
    INTO target_job_id, invitee_id, provider_id, customer_id
  FROM job_participants participant
  JOIN craftsman_profiles invitee
    ON invitee.id = participant.craftsman_profile_id
  JOIN jobs job ON job.id = participant.job_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  JOIN customer_profiles customer
    ON customer.id = job.customer_profile_id
  WHERE participant.id = NEW.participant_id;
  IF target_job_id IS NULL OR invitee_id IS NULL
      OR provider_id IS NULL OR customer_id IS NULL THEN
    RAISE EXCEPTION 'Job participant notification parties missing';
  END IF;
  source_key := 'job-participant:' || NEW.participant_id::text
    || ':event:' || NEW.event_id::text;

  IF NEW.event_kind = 'ACCEPT' THEN
    PERFORM emit_job_participant_notification(
      source_key || ':provider', 'job_participant.accepted',
      NEW.recorded_at, NEW.participant_id, target_job_id, provider_id,
      NEW.event_sequence, NEW.event_id
    );
    PERFORM emit_job_participant_notification(
      source_key || ':customer', 'job_participant.joined',
      NEW.recorded_at, NEW.participant_id, target_job_id, customer_id,
      NEW.event_sequence, NEW.event_id
    );
  ELSIF NEW.event_kind = 'DECLINE' THEN
    PERFORM emit_job_participant_notification(
      source_key || ':provider', 'job_participant.declined',
      NEW.recorded_at, NEW.participant_id, target_job_id, provider_id,
      NEW.event_sequence, NEW.event_id
    );
  ELSIF NEW.event_kind = 'LEAVE' THEN
    PERFORM emit_job_participant_notification(
      source_key || ':provider', 'job_participant.left',
      NEW.recorded_at, NEW.participant_id, target_job_id, provider_id,
      NEW.event_sequence, NEW.event_id
    );
    PERFORM emit_job_participant_notification(
      source_key || ':customer', 'job_participant.departed',
      NEW.recorded_at, NEW.participant_id, target_job_id, customer_id,
      NEW.event_sequence, NEW.event_id
    );
  ELSE
    PERFORM emit_job_participant_notification(
      source_key || ':invitee', 'job_participant.removed',
      NEW.recorded_at, NEW.participant_id, target_job_id, invitee_id,
      NEW.event_sequence, NEW.event_id
    );
    PERFORM emit_job_participant_notification(
      source_key || ':customer', 'job_participant.departed',
      NEW.recorded_at, NEW.participant_id, target_job_id, customer_id,
      NEW.event_sequence, NEW.event_id
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER job_participant_decision_notify
AFTER INSERT ON job_participant_events
FOR EACH ROW EXECUTE FUNCTION notify_job_participant_decision();
