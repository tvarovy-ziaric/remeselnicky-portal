CREATE FUNCTION capture_job_invitation_notification_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind job_invitation_command_kind;
  recipient_id uuid;
  event_name text;
  event_key text;
BEGIN
  SELECT command_kind INTO source_kind
  FROM job_invitation_commands
  WHERE command_id = NEW.command_id;

  IF source_kind = 'SEND' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN craftsman_profiles profile
      ON profile.id = invitation.craftsman_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.sent';
    event_key := 'job-invitation:' || NEW.invitation_id::text || ':sent';
  ELSIF source_kind = 'EXPIRE' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN customer_profiles profile
      ON profile.id = invitation.customer_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.expired';
    event_key := 'job-invitation:' || NEW.invitation_id::text || ':expired';
  ELSE
    RETURN NEW;
  END IF;

  IF recipient_id IS NULL THEN
    RAISE EXCEPTION 'invitation notification recipient missing';
  END IF;

  INSERT INTO domain_outbox_events (
    event_id,
    idempotency_key,
    event_name,
    schema_version,
    occurred_at,
    entity_type,
    entity_id,
    payload,
    command_name,
    correlation_id,
    available_at
  ) VALUES (
    gen_random_uuid(),
    event_key,
    event_name,
    1,
    NEW.changed_at,
    'JOB_INVITATION',
    NEW.invitation_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'invitation_revision', NEW.revision
    ),
    CASE source_kind
      WHEN 'SEND' THEN 'job_invitation.send'
      ELSE 'job_invitation.expire'
    END,
    NEW.command_id::text,
    GREATEST(CURRENT_TIMESTAMP, NEW.changed_at)
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER job_invitation_notification_event_capture
AFTER INSERT ON job_invitation_revisions
FOR EACH ROW EXECUTE FUNCTION capture_job_invitation_notification_event();

COMMENT ON FUNCTION capture_job_invitation_notification_event() IS
  'Atomically captures privacy-minimal SEND/EXPIRE events; delivery never controls invitation state.';
