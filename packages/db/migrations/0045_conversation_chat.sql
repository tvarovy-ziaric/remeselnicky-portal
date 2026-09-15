CREATE TYPE conversation_timeline_entry_kind AS ENUM (
  'HUMAN_MESSAGE', 'SYSTEM_EVENT'
);
CREATE TYPE conversation_system_event AS ENUM ('ENGAGEMENT');
CREATE TYPE conversation_participant_action AS ENUM (
  'MARK_READ', 'ARCHIVE', 'UNARCHIVE', 'MUTE', 'UNMUTE'
);
CREATE TYPE conversation_report_reason AS ENUM (
  'ABUSE', 'CONTACT_CIRCUMVENTION', 'FRAUD_OR_SCAM', 'THREAT', 'OTHER'
);

CREATE TABLE conversation_message_commands (
  command_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL,
  reply_to_message_id uuid,
  resulting_message_id uuid NOT NULL UNIQUE,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT conversation_message_commands_body CHECK (
    char_length(body) BETWEEN 1 AND 4000
    AND octet_length(body) <= 16000
    AND body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
  ),
  CONSTRAINT conversation_message_commands_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE conversation_timeline_entries (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL,
  entry_kind conversation_timeline_entry_kind NOT NULL,
  author_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  body text,
  reply_to_message_id uuid,
  message_command_id uuid UNIQUE
    REFERENCES conversation_message_commands(command_id) ON DELETE RESTRICT,
  system_event conversation_system_event,
  source_invitation_id uuid,
  source_invitation_revision integer,
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, sequence),
  UNIQUE (source_invitation_id, source_invitation_revision, system_event),
  FOREIGN KEY (source_invitation_id, source_invitation_revision)
    REFERENCES job_invitation_revisions(invitation_id, revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (reply_to_message_id)
    REFERENCES conversation_timeline_entries(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_timeline_entries_sequence CHECK (sequence > 0),
  CONSTRAINT conversation_timeline_entries_shape CHECK (
    (entry_kind = 'HUMAN_MESSAGE'
      AND author_user_id IS NOT NULL AND body IS NOT NULL
      AND message_command_id IS NOT NULL AND system_event IS NULL
      AND source_invitation_id IS NULL
      AND source_invitation_revision IS NULL)
    OR
    (entry_kind = 'SYSTEM_EVENT'
      AND author_user_id IS NULL AND body IS NULL
      AND reply_to_message_id IS NULL AND message_command_id IS NULL
      AND system_event IS NOT NULL
      AND source_invitation_id IS NOT NULL
      AND source_invitation_revision IS NOT NULL)
  )
);

ALTER TABLE conversation_message_commands
  ADD CONSTRAINT conversation_message_commands_reply_fk
  FOREIGN KEY (reply_to_message_id)
  REFERENCES conversation_timeline_entries(id) ON DELETE RESTRICT;

CREATE TABLE conversation_participant_state_commands (
  command_id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action conversation_participant_action NOT NULL,
  expected_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  read_through_sequence bigint,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT conversation_participant_commands_revision CHECK (
    expected_revision >= 0 AND resulting_revision = expected_revision + 1
  ),
  CONSTRAINT conversation_participant_commands_read_shape CHECK (
    (action = 'MARK_READ' AND read_through_sequence IS NOT NULL
      AND read_through_sequence > 0)
    OR (action <> 'MARK_READ' AND read_through_sequence IS NULL)
  ),
  CONSTRAINT conversation_participant_commands_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE conversation_participant_state_revisions (
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES conversation_participant_state_commands(command_id)
    ON DELETE RESTRICT,
  last_read_sequence bigint NOT NULL,
  last_read_at timestamptz,
  archived boolean NOT NULL,
  muted boolean NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, actor_user_id, revision),
  CONSTRAINT conversation_participant_revisions_positive CHECK (revision > 0),
  CONSTRAINT conversation_participant_revisions_read CHECK (
    last_read_sequence >= 0
  )
);

CREATE VIEW current_conversation_participant_states AS
SELECT DISTINCT ON (revision.conversation_id, revision.actor_user_id)
  revision.conversation_id, revision.actor_user_id, revision.revision,
  revision.last_read_sequence, revision.last_read_at, revision.archived,
  revision.muted, revision.changed_at
FROM conversation_participant_state_revisions revision
ORDER BY revision.conversation_id, revision.actor_user_id,
  revision.revision DESC;

CREATE TABLE conversation_reports (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message_id uuid REFERENCES conversation_timeline_entries(id)
    ON DELETE RESTRICT,
  reason conversation_report_reason NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT conversation_reports_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE FUNCTION conversation_participant_is_active(
  target_conversation_id uuid,
  target_user_id uuid,
  require_writable boolean
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM current_conversations current
    JOIN customer_profiles customer
      ON customer.id = current.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = current.craftsman_profile_id
    JOIN users actor ON actor.id = target_user_id
      AND actor.account_state = 'ACTIVE'
    WHERE current.id = target_conversation_id
      AND (customer.owner_user_id = actor.id
        OR craftsman.owner_user_id = actor.id)
      AND (NOT require_writable OR current.access_state = 'WRITABLE')
  );
$$;

CREATE FUNCTION validate_conversation_message_command()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45001)
  );
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
  -- Temporary conservative pre-confirmation guard. R3-014 replaces this
  -- function with confirmed-Job-aware masking/blocking rules.
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
CREATE TRIGGER conversation_message_commands_guard
BEFORE INSERT ON conversation_message_commands
FOR EACH ROW EXECUTE FUNCTION validate_conversation_message_command();

CREATE FUNCTION validate_conversation_timeline_entry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source conversation_message_commands%ROWTYPE;
  invitation_id uuid;
BEGIN
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation identity required'; END IF;
  SELECT coalesce(max(entry.sequence), 0) + 1 INTO NEW.sequence
  FROM conversation_timeline_entries entry
  WHERE entry.conversation_id = NEW.conversation_id;

  IF NEW.entry_kind = 'HUMAN_MESSAGE' THEN
    SELECT * INTO source FROM conversation_message_commands
    WHERE command_id = NEW.message_command_id FOR UPDATE;
    IF NOT FOUND OR source.conversation_id <> NEW.conversation_id THEN
      RAISE EXCEPTION 'message entry requires matching command';
    END IF;
    NEW.id := source.resulting_message_id;
    NEW.author_user_id := source.actor_user_id;
    NEW.body := source.body;
    NEW.reply_to_message_id := source.reply_to_message_id;
    NEW.created_at := source.created_at;
    NEW.system_event := NULL;
    NEW.source_invitation_id := NULL;
    NEW.source_invitation_revision := NULL;
  ELSE
    SELECT conversation.invitation_id INTO invitation_id
    FROM conversations conversation WHERE conversation.id = NEW.conversation_id;
    IF NEW.system_event <> 'ENGAGEMENT'
        OR NEW.source_invitation_id <> invitation_id
        OR NOT EXISTS (
          SELECT 1 FROM job_invitation_revisions revision
          WHERE revision.invitation_id = NEW.source_invitation_id
            AND revision.revision = NEW.source_invitation_revision
            AND revision.state = 'ENGAGED'
        ) THEN
      RAISE EXCEPTION 'system event requires exact engagement provenance';
    END IF;
    NEW.id := gen_random_uuid();
    NEW.created_at := (
      SELECT changed_at FROM job_invitation_revisions revision
      WHERE revision.invitation_id = NEW.source_invitation_id
        AND revision.revision = NEW.source_invitation_revision
    );
    NEW.author_user_id := NULL;
    NEW.body := NULL;
    NEW.reply_to_message_id := NULL;
    NEW.message_command_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_timeline_entries_guard
BEFORE INSERT ON conversation_timeline_entries
FOR EACH ROW EXECUTE FUNCTION validate_conversation_timeline_entry();

CREATE FUNCTION ensure_conversation_message_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversation_timeline_entries entry
    WHERE entry.message_command_id = NEW.command_id
      AND entry.id = NEW.resulting_message_id
      AND entry.conversation_id = NEW.conversation_id
      AND entry.entry_kind = 'HUMAN_MESSAGE'
  ) THEN
    RAISE EXCEPTION 'message command requires exact timeline effect';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER conversation_message_command_effect_required
AFTER INSERT ON conversation_message_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_conversation_message_command_effect();

CREATE FUNCTION create_engagement_timeline_entry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  engaged_revision integer;
BEGIN
  SELECT revision.revision INTO engaged_revision
  FROM job_invitation_revisions revision
  WHERE revision.invitation_id = NEW.invitation_id
    AND revision.state = 'ENGAGED'
  ORDER BY revision.revision LIMIT 1;
  IF engaged_revision IS NULL THEN
    RAISE EXCEPTION 'conversation engagement provenance required';
  END IF;
  INSERT INTO conversation_timeline_entries (
    id, conversation_id, sequence, entry_kind, author_user_id, body,
    reply_to_message_id, message_command_id, system_event,
    source_invitation_id, source_invitation_revision, created_at
  ) VALUES (
    gen_random_uuid(), NEW.id, 1, 'SYSTEM_EVENT', NULL, NULL, NULL, NULL,
    'ENGAGEMENT', NEW.invitation_id, engaged_revision, clock_timestamp()
  ) ON CONFLICT (source_invitation_id, source_invitation_revision, system_event)
    DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversations_create_engagement_timeline_entry
AFTER INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION create_engagement_timeline_entry();

INSERT INTO conversation_timeline_entries (
  id, conversation_id, sequence, entry_kind, author_user_id, body,
  reply_to_message_id, message_command_id, system_event,
  source_invitation_id, source_invitation_revision, created_at
)
SELECT gen_random_uuid(), conversation.id, 1, 'SYSTEM_EVENT', NULL, NULL,
  NULL, NULL, 'ENGAGEMENT', conversation.invitation_id, engaged.revision,
  engaged.changed_at
FROM conversations conversation
JOIN LATERAL (
  SELECT revision.revision, revision.changed_at
  FROM job_invitation_revisions revision
  WHERE revision.invitation_id = conversation.invitation_id
    AND revision.state = 'ENGAGED'
  ORDER BY revision.revision LIMIT 1
) engaged ON true
ON CONFLICT (source_invitation_id, source_invitation_revision, system_event)
  DO NOTHING;

CREATE FUNCTION validate_conversation_participant_state_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_state conversation_participant_state_revisions%ROWTYPE;
  maximum_sequence bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45002)
  );
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND OR NOT conversation_participant_is_active(
      NEW.conversation_id, NEW.actor_user_id, false
    ) THEN
    RAISE EXCEPTION 'active participant conversation required';
  END IF;
  SELECT * INTO current_state
  FROM conversation_participant_state_revisions revision
  WHERE revision.conversation_id = NEW.conversation_id
    AND revision.actor_user_id = NEW.actor_user_id
  ORDER BY revision.revision DESC LIMIT 1 FOR UPDATE;
  IF coalesce(current_state.revision, 0) <> NEW.expected_revision THEN
    RAISE EXCEPTION 'participant state command is stale';
  END IF;
  IF NEW.action = 'MARK_READ' THEN
    SELECT max(entry.sequence) INTO maximum_sequence
    FROM conversation_timeline_entries entry
    WHERE entry.conversation_id = NEW.conversation_id;
    IF maximum_sequence IS NULL OR NEW.read_through_sequence > maximum_sequence THEN
      RAISE EXCEPTION 'read marker exceeds conversation timeline';
    END IF;
  END IF;
  NEW.resulting_revision := NEW.expected_revision + 1;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_participant_state_commands_guard
BEFORE INSERT ON conversation_participant_state_commands
FOR EACH ROW EXECUTE FUNCTION validate_conversation_participant_state_command();

CREATE FUNCTION validate_conversation_participant_state_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source conversation_participant_state_commands%ROWTYPE;
  prior conversation_participant_state_revisions%ROWTYPE;
BEGIN
  SELECT * INTO source FROM conversation_participant_state_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.conversation_id <> NEW.conversation_id
      OR source.actor_user_id <> NEW.actor_user_id
      OR source.resulting_revision <> NEW.revision THEN
    RAISE EXCEPTION 'participant state revision requires matching command';
  END IF;
  SELECT * INTO prior FROM conversation_participant_state_revisions revision
  WHERE revision.conversation_id = NEW.conversation_id
    AND revision.actor_user_id = NEW.actor_user_id
  ORDER BY revision.revision DESC LIMIT 1 FOR UPDATE;
  IF coalesce(prior.revision, 0) <> source.expected_revision THEN
    RAISE EXCEPTION 'participant state revision sequence is invalid';
  END IF;
  NEW.last_read_sequence := CASE WHEN source.action = 'MARK_READ'
    THEN greatest(coalesce(prior.last_read_sequence, 0), source.read_through_sequence)
    ELSE coalesce(prior.last_read_sequence, 0) END;
  NEW.last_read_at := CASE WHEN source.action = 'MARK_READ'
    THEN source.created_at ELSE prior.last_read_at END;
  NEW.archived := CASE source.action
    WHEN 'ARCHIVE' THEN true WHEN 'UNARCHIVE' THEN false
    ELSE coalesce(prior.archived, false) END;
  NEW.muted := CASE source.action
    WHEN 'MUTE' THEN true WHEN 'UNMUTE' THEN false
    ELSE coalesce(prior.muted, false) END;
  NEW.changed_at := source.created_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_participant_state_revisions_guard
BEFORE INSERT ON conversation_participant_state_revisions
FOR EACH ROW EXECUTE FUNCTION validate_conversation_participant_state_revision();

CREATE FUNCTION ensure_conversation_participant_state_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participant_state_revisions revision
    WHERE revision.command_id = NEW.command_id
      AND revision.conversation_id = NEW.conversation_id
      AND revision.actor_user_id = NEW.actor_user_id
      AND revision.revision = NEW.resulting_revision
  ) THEN
    RAISE EXCEPTION 'participant state command requires exact effect';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER conversation_participant_state_effect_required
AFTER INSERT ON conversation_participant_state_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_conversation_participant_state_effect();

CREATE FUNCTION validate_conversation_report()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45003)
  );
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = NEW.conversation_id FOR UPDATE;
  IF NOT FOUND OR NOT conversation_participant_is_active(
      NEW.conversation_id, NEW.reporter_user_id, false
    ) THEN
    RAISE EXCEPTION 'active reporting participant required';
  END IF;
  IF NEW.message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_timeline_entries entry
    WHERE entry.id = NEW.message_id
      AND entry.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'reported message must belong to conversation';
  END IF;
  NEW.id := gen_random_uuid();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_reports_guard
BEFORE INSERT ON conversation_reports
FOR EACH ROW EXECUTE FUNCTION validate_conversation_report();

CREATE FUNCTION reject_conversation_chat_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'conversation chat history is append-only'; END;
$$;
CREATE TRIGGER conversation_message_commands_append_only
BEFORE UPDATE OR DELETE ON conversation_message_commands
FOR EACH ROW EXECUTE FUNCTION reject_conversation_chat_history_mutation();
CREATE TRIGGER conversation_timeline_entries_append_only
BEFORE UPDATE OR DELETE ON conversation_timeline_entries
FOR EACH ROW EXECUTE FUNCTION reject_conversation_chat_history_mutation();
CREATE TRIGGER conversation_participant_state_commands_append_only
BEFORE UPDATE OR DELETE ON conversation_participant_state_commands
FOR EACH ROW EXECUTE FUNCTION reject_conversation_chat_history_mutation();
CREATE TRIGGER conversation_participant_state_revisions_append_only
BEFORE UPDATE OR DELETE ON conversation_participant_state_revisions
FOR EACH ROW EXECUTE FUNCTION reject_conversation_chat_history_mutation();
CREATE TRIGGER conversation_reports_append_only
BEFORE UPDATE OR DELETE ON conversation_reports
FOR EACH ROW EXECUTE FUNCTION reject_conversation_chat_history_mutation();

CREATE INDEX conversation_timeline_entries_page_idx
  ON conversation_timeline_entries (conversation_id, sequence DESC);
CREATE INDEX conversation_timeline_entries_unread_idx
  ON conversation_timeline_entries (conversation_id, author_user_id, sequence);
CREATE INDEX conversation_reports_moderation_idx
  ON conversation_reports (created_at, id);

COMMENT ON TABLE conversation_timeline_entries IS
  'Immutable invitation-scoped human messages and provenance-bound system events.';
COMMENT ON TABLE conversation_reports IS
  'Privacy-minimal participant reports; content access remains a separately authorized audited moderation concern.';
COMMENT ON VIEW current_conversation_participant_states IS
  'Current local read/archive/mute projection derived from append-only participant revisions.';
