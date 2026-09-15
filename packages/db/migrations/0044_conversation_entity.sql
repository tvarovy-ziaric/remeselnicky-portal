CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL UNIQUE
    REFERENCES job_invitations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_conversation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM job_invitations invitation
  WHERE invitation.id = NEW.invitation_id
    AND EXISTS (
      SELECT 1
      FROM job_invitation_revisions revision
      WHERE revision.invitation_id = invitation.id
        AND revision.state = 'ENGAGED'
    )
  FOR UPDATE OF invitation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation requires a historically engaged invitation';
  END IF;

  NEW.id := gen_random_uuid();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_identity_guard
BEFORE INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION validate_conversation_identity();

CREATE FUNCTION create_conversation_after_engagement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'ENGAGED' THEN
    INSERT INTO conversations (invitation_id)
    VALUES (NEW.invitation_id)
    ON CONFLICT (invitation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_invitation_engagement_creates_conversation
AFTER INSERT ON job_invitation_revisions
FOR EACH ROW EXECUTE FUNCTION create_conversation_after_engagement();

-- Preserve continuity when this migration is applied over existing engagements.
INSERT INTO conversations (invitation_id)
SELECT DISTINCT revision.invitation_id
FROM job_invitation_revisions revision
WHERE revision.state = 'ENGAGED'
ORDER BY revision.invitation_id
ON CONFLICT (invitation_id) DO NOTHING;

CREATE VIEW current_conversations AS
SELECT conversation.id,
  conversation.invitation_id,
  invitation.job_request_id,
  invitation.customer_profile_id,
  invitation.craftsman_profile_id,
  conversation.created_at,
  CASE
    WHEN current.state = 'ENGAGED' THEN 'WRITABLE'
    ELSE 'READ_ONLY'
  END AS access_state,
  current.state AS invitation_state
FROM conversations conversation
JOIN job_invitations invitation ON invitation.id = conversation.invitation_id
JOIN current_job_invitations current ON current.id = invitation.id;

CREATE FUNCTION reject_conversation_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'conversation identity is append-only';
END;
$$;

CREATE TRIGGER conversations_append_only
BEFORE UPDATE OR DELETE ON conversations
FOR EACH ROW EXECUTE FUNCTION reject_conversation_identity_mutation();

COMMENT ON TABLE conversations IS
  'One immutable private conversation per historically ENGAGED invitation; message state is separate.';
COMMENT ON VIEW current_conversations IS
  'Current invitation-derived write access; terminal candidate contexts remain readable history.';
