CREATE FUNCTION validate_conversation_attachment_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_message conversation_timeline_entries%ROWTYPE;
  source_invitation_id uuid;
  current_total integer;
  current_images integer;
BEGIN
  IF TG_OP = 'UPDATE'
      AND (OLD.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
        OR NEW.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')) THEN
    IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
        OR OLD.uploaded_by_user_id IS DISTINCT FROM NEW.uploaded_by_user_id
        OR OLD.kind IS DISTINCT FROM NEW.kind
        OR OLD.purpose IS DISTINCT FROM NEW.purpose
        OR OLD.declared_content_type IS DISTINCT FROM NEW.declared_content_type
        OR OLD.display_filename IS DISTINCT FROM NEW.display_filename
        OR OLD.byte_size IS DISTINCT FROM NEW.byte_size
        OR OLD.provenance_entity_type IS DISTINCT FROM NEW.provenance_entity_type
        OR OLD.provenance_entity_id IS DISTINCT FROM NEW.provenance_entity_id
        OR OLD.provenance_entity_revision IS DISTINCT FROM NEW.provenance_entity_revision
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'conversation attachment identity and provenance are immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.purpose NOT IN ('CHAT_IMAGE', 'CHAT_DOCUMENT') THEN
    RETURN NEW;
  END IF;

  IF NEW.provenance_entity_type IS DISTINCT FROM 'CONVERSATION_MESSAGE'
      OR NEW.provenance_entity_id IS NULL
      OR NEW.provenance_entity_revision IS NULL
      OR (NEW.purpose = 'CHAT_IMAGE' AND NEW.kind <> 'IMAGE')
      OR (NEW.purpose = 'CHAT_DOCUMENT' AND NEW.kind <> 'DOCUMENT') THEN
    RAISE EXCEPTION 'conversation attachment requires exact purpose and message provenance';
  END IF;

  -- Match invitation commands: ACTIVE actor, invitation identity, then chat rows.
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.uploaded_by_user_id
    AND actor.account_state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active writable message author required for conversation attachment';
  END IF;
  SELECT conversation.invitation_id INTO source_invitation_id
  FROM conversation_timeline_entries message
  JOIN conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = NEW.provenance_entity_id;
  IF source_invitation_id IS NULL THEN
    RAISE EXCEPTION 'conversation attachment source message required';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_invitation_id FOR UPDATE;

  PERFORM 1
  FROM conversations conversation
  JOIN current_conversations current ON current.id = conversation.id
  JOIN customer_profiles customer
    ON customer.id = current.customer_profile_id
  JOIN craftsman_profiles craftsman
    ON craftsman.id = current.craftsman_profile_id
  JOIN users actor ON actor.id = NEW.uploaded_by_user_id
    AND actor.account_state = 'ACTIVE'
  WHERE current.access_state = 'WRITABLE'
    AND (customer.owner_user_id = actor.id
      OR craftsman.owner_user_id = actor.id)
    AND EXISTS (
      SELECT 1 FROM conversation_timeline_entries message
      WHERE message.id = NEW.provenance_entity_id
        AND message.conversation_id = current.id
        AND message.entry_kind = 'HUMAN_MESSAGE'
        AND message.author_user_id = actor.id
        AND message.sequence = NEW.provenance_entity_revision
    )
  FOR UPDATE OF conversation;
  IF NOT FOUND OR NEW.owner_user_id <> NEW.uploaded_by_user_id THEN
    RAISE EXCEPTION 'active writable message author required for conversation attachment';
  END IF;

  SELECT * INTO source_message
  FROM conversation_timeline_entries message
  WHERE message.id = NEW.provenance_entity_id
  FOR UPDATE;
  IF NOT FOUND OR source_message.entry_kind <> 'HUMAN_MESSAGE'
      OR source_message.author_user_id <> NEW.uploaded_by_user_id
      OR source_message.sequence <> NEW.provenance_entity_revision THEN
    RAISE EXCEPTION 'conversation attachment source message changed';
  END IF;

  SELECT count(*)::integer,
    count(*) FILTER (WHERE asset.kind = 'IMAGE')::integer
  INTO current_total, current_images
  FROM media_assets asset
  WHERE asset.provenance_entity_type = 'CONVERSATION_MESSAGE'
    AND asset.provenance_entity_id = source_message.id
    AND asset.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT');
  IF current_total >= 10
      OR (NEW.kind = 'IMAGE' AND current_images >= 5) THEN
    RAISE EXCEPTION 'conversation message attachment technical limit reached';
  END IF;
  RETURN NEW;
END;
$$;

-- Harden the R3-012 raw-SQL message boundary against a concurrent invitation
-- close. The actor and invitation identity use the same serialization order as
-- repository invitation commands; the state is re-read after those locks.
CREATE OR REPLACE FUNCTION validate_conversation_message_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_invitation_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45001)
  );
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writable participant conversation required';
  END IF;
  SELECT invitation_id INTO source_invitation_id
  FROM conversations WHERE id = NEW.conversation_id;
  IF source_invitation_id IS NULL THEN
    RAISE EXCEPTION 'writable participant conversation required';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND OR NOT conversation_participant_is_active(
      NEW.conversation_id, NEW.actor_user_id, true
    ) THEN
    RAISE EXCEPTION 'writable participant conversation required';
  END IF;
  IF NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_timeline_entries reply
    WHERE reply.id = NEW.reply_to_message_id
      AND reply.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'reply message must belong to conversation';
  END IF;
  IF NEW.body ~* '[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}'
      OR NEW.body ~ '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)'
      OR NEW.body ~* '(psč|psc)[^0-9]{0,12}[0-9]{3}[[:space:]]?[0-9]{2}'
      OR NEW.body ~* '(^|[^[:alpha:]])(adresa|ulica|námestie|trieda|číslo domu|číslo bytu|ul\.|nám\.)([^[:alpha:]]|$)'
  THEN
    RAISE EXCEPTION 'message blocked by pre-confirmation contact policy';
  END IF;
  NEW.resulting_message_id := gen_random_uuid();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_assets_conversation_attachment_guard
BEFORE INSERT OR UPDATE OF id, owner_user_id, uploaded_by_user_id, kind,
  purpose, declared_content_type, display_filename, byte_size,
  provenance_entity_type, provenance_entity_id, provenance_entity_revision,
  created_at
ON media_assets
FOR EACH ROW EXECUTE FUNCTION validate_conversation_attachment_asset();

CREATE FUNCTION reject_conversation_attachment_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT') THEN
    RAISE EXCEPTION 'conversation attachment provenance is append-only';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER media_assets_conversation_attachment_delete_guard
BEFORE DELETE ON media_assets
FOR EACH ROW EXECUTE FUNCTION reject_conversation_attachment_delete();

CREATE VIEW conversation_job_media_candidates AS
SELECT message.conversation_id,
  message.id AS source_message_id,
  asset.id AS media_asset_id,
  asset.uploaded_by_user_id,
  asset.kind AS media_kind,
  coalesce(asset.captured_at, asset.created_at) AS chronological_at
FROM media_assets asset
JOIN conversation_timeline_entries message
  ON message.id = asset.provenance_entity_id
  AND message.entry_kind = 'HUMAN_MESSAGE'
  AND message.author_user_id = asset.uploaded_by_user_id
  AND message.sequence = asset.provenance_entity_revision
JOIN media_asset_storage_objects canonical
  ON canonical.media_asset_id = asset.id
  AND canonical.role = 'CANONICAL'
  AND canonical.storage_area = 'private'
  AND canonical.revoked_at IS NULL
WHERE asset.provenance_entity_type = 'CONVERSATION_MESSAGE'
  AND asset.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
  AND asset.status = 'READY';

CREATE INDEX media_assets_conversation_message_timeline_idx
  ON media_assets (provenance_entity_id, created_at, id)
  WHERE provenance_entity_type = 'CONVERSATION_MESSAGE'
    AND purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT');

COMMENT ON VIEW conversation_job_media_candidates IS
  'Private READY conversation media candidates for a future confirmed-Job chronology. This view has no Job/public authority; the future Job layer must intersect the winning conversation and current authorization.';
