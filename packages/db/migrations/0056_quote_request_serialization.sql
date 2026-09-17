-- All Quote state commands serialize on the same request-scoped advisory lock
-- used by invitation/request commands and the future acceptQuote transaction.
-- This runs before the existing command guards lock actor/invitation rows.
CREATE FUNCTION lock_quote_command_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_request_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'quote_core_commands' THEN
    SELECT invitation.job_request_id INTO target_request_id
    FROM conversations conversation
    JOIN job_invitations invitation
      ON invitation.id = conversation.invitation_id
    WHERE conversation.id = NEW.conversation_id;
  ELSIF TG_TABLE_NAME = 'quote_lifecycle_commands' THEN
    SELECT invitation.job_request_id INTO target_request_id
    FROM quotes quote
    JOIN conversations conversation
      ON conversation.id = quote.conversation_id
      AND conversation.id = NEW.conversation_id
    JOIN job_invitations invitation
      ON invitation.id = quote.invitation_id
    WHERE quote.id = NEW.quote_id;
  ELSE
    RAISE EXCEPTION 'unsupported Quote command source';
  END IF;
  IF target_request_id IS NULL THEN
    RAISE EXCEPTION 'owned Quote request context required';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(target_request_id::text, 41007)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_quote_core_request_serialization
BEFORE INSERT ON quote_core_commands
FOR EACH ROW EXECUTE FUNCTION lock_quote_command_request();

CREATE TRIGGER a_quote_lifecycle_request_serialization
BEFORE INSERT ON quote_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION lock_quote_command_request();
