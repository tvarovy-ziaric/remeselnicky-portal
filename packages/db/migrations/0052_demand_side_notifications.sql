CREATE TABLE demand_notification_runtime_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  chat_email_delay_seconds integer NOT NULL DEFAULT 900
    CHECK (chat_email_delay_seconds BETWEEN 1 AND 86400),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO demand_notification_runtime_policy DEFAULT VALUES;

-- A small DB-derived state row serializes message creation against the exact
-- recipient's mute/read commands. It contains no message or contact content.
CREATE TABLE conversation_notification_states (
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  muted boolean NOT NULL DEFAULT false,
  last_read_sequence bigint NOT NULL DEFAULT 0,
  latest_notifiable_sequence bigint NOT NULL DEFAULT 0,
  latest_notifiable_at timestamptz,
  email_considered_through_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, recipient_user_id),
  CONSTRAINT conversation_notification_state_sequence CHECK (
    last_read_sequence >= 0 AND latest_notifiable_sequence >= 0
    AND email_considered_through_sequence >= 0
  ),
  CONSTRAINT conversation_notification_state_time_shape CHECK (
    (latest_notifiable_sequence = 0 AND latest_notifiable_at IS NULL)
    OR (latest_notifiable_sequence > 0 AND latest_notifiable_at IS NOT NULL)
  )
);

INSERT INTO conversation_notification_states (
  conversation_id, recipient_user_id, muted, last_read_sequence,
  latest_notifiable_sequence, latest_notifiable_at,
  email_considered_through_sequence, updated_at
)
SELECT conversation.id, participant.user_id,
  coalesce(state.muted, false), coalesce(state.last_read_sequence, 0),
  0, NULL, 0, clock_timestamp()
FROM conversations conversation
JOIN current_conversations current ON current.id = conversation.id
JOIN customer_profiles customer ON customer.id = current.customer_profile_id
JOIN craftsman_profiles craftsman ON craftsman.id = current.craftsman_profile_id
CROSS JOIN LATERAL (
  VALUES (customer.owner_user_id), (craftsman.owner_user_id)
) participant(user_id)
LEFT JOIN current_conversation_participant_states state
  ON state.conversation_id = conversation.id
  AND state.actor_user_id = participant.user_id
ON CONFLICT (conversation_id, recipient_user_id) DO NOTHING;

CREATE FUNCTION seed_conversation_notification_states()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversation_notification_states (
    conversation_id, recipient_user_id
  )
  SELECT NEW.id, participant.user_id
  FROM job_invitations invitation
  JOIN customer_profiles customer
    ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman
    ON craftsman.id = invitation.craftsman_profile_id
  CROSS JOIN LATERAL (
    VALUES (customer.owner_user_id), (craftsman.owner_user_id)
  ) participant(user_id)
  WHERE invitation.id = NEW.invitation_id
  ON CONFLICT (conversation_id, recipient_user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversations_seed_notification_states
AFTER INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION seed_conversation_notification_states();

CREATE FUNCTION protect_conversation_notification_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'conversation notification state is DB-derived';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER conversation_notification_states_derived_only
BEFORE INSERT OR UPDATE OR DELETE ON conversation_notification_states
FOR EACH ROW EXECUTE FUNCTION protect_conversation_notification_state();

CREATE FUNCTION lock_conversation_message_notification_recipient()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45001)
  );
  SELECT CASE
      WHEN customer.owner_user_id = NEW.actor_user_id
        THEN craftsman.owner_user_id
      WHEN craftsman.owner_user_id = NEW.actor_user_id
        THEN customer.owner_user_id
    END
    INTO recipient_id
  FROM conversations conversation
  JOIN job_invitations invitation
    ON invitation.id = conversation.invitation_id
  JOIN customer_profiles customer
    ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman
    ON craftsman.id = invitation.craftsman_profile_id
  WHERE conversation.id = NEW.conversation_id;

  IF recipient_id IS NOT NULL THEN
    PERFORM 1 FROM conversation_notification_states state
    WHERE state.conversation_id = NEW.conversation_id
      AND state.recipient_user_id = recipient_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation notification recipient state missing';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- PostgreSQL orders same-kind triggers by name. This takes the command lock
-- before state, then precedes the existing conversation/message guard.
CREATE TRIGGER a_conversation_message_notification_recipient_lock
BEFORE INSERT ON conversation_message_commands
FOR EACH ROW EXECUTE FUNCTION lock_conversation_message_notification_recipient();

CREATE FUNCTION lock_conversation_notification_preference()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.command_id::text, 45002)
  );
  PERFORM 1 FROM conversation_notification_states state
  WHERE state.conversation_id = NEW.conversation_id
    AND state.recipient_user_id = NEW.actor_user_id
  FOR UPDATE;
  -- Invalid/foreign actors are denied uniformly by the existing authoritative
  -- participant guard, which runs next. Only valid participant effects must
  -- have a mirror row.
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_conversation_notification_preference_lock
BEFORE INSERT ON conversation_participant_state_commands
FOR EACH ROW EXECUTE FUNCTION lock_conversation_notification_preference();

CREATE FUNCTION mirror_conversation_notification_preference()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_action conversation_participant_action;
BEGIN
  SELECT command.action INTO source_action
  FROM conversation_participant_state_commands command
  WHERE command.command_id = NEW.command_id;
  UPDATE conversation_notification_states state
  SET muted = NEW.muted,
      last_read_sequence = NEW.last_read_sequence,
      email_considered_through_sequence = greatest(
        state.email_considered_through_sequence,
        CASE source_action
          WHEN 'MUTE' THEN state.latest_notifiable_sequence
          WHEN 'MARK_READ' THEN NEW.last_read_sequence
          ELSE state.email_considered_through_sequence
        END
      ),
      updated_at = NEW.changed_at
  WHERE state.conversation_id = NEW.conversation_id
    AND state.recipient_user_id = NEW.actor_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation notification recipient state missing';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_participant_state_mirrors_notifications
AFTER INSERT ON conversation_participant_state_revisions
FOR EACH ROW EXECUTE FUNCTION mirror_conversation_notification_preference();

-- Material edits and invitation transitions share the existing request-level
-- lock used by invitation creation. The command statement acquires it before
-- either path's object locks, and their effects are inserted by later
-- statements, so the effect trigger observes the winning committed order.
CREATE FUNCTION lock_notification_job_request_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.job_request_id::text, 41007)
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_job_request_notification_edit_lock
BEFORE INSERT ON job_request_active_edit_commands
FOR EACH ROW EXECUTE FUNCTION lock_notification_job_request_edit();

-- CANCEL/EXPIRE repositories acquire this lock before request rows. This
-- alphabetically-early raw-SQL guard makes direct commands use the same order.
CREATE FUNCTION lock_notification_job_request_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_kind::text IN ('CANCEL', 'EXPIRE') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(NEW.job_request_id::text, 41007)
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_job_request_notification_transition_lock
BEFORE INSERT ON job_request_commands
FOR EACH ROW EXECUTE FUNCTION lock_notification_job_request_transition();

CREATE FUNCTION lock_notification_invitation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id uuid;
BEGIN
  SELECT invitation.job_request_id INTO request_id
  FROM job_invitations invitation
  WHERE invitation.id = NEW.invitation_id;
  IF request_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(request_id::text, 41007));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_job_invitation_notification_transition_lock
BEFORE INSERT ON job_invitation_commands
FOR EACH ROW EXECUTE FUNCTION lock_notification_invitation_transition();

CREATE FUNCTION insert_exact_notification_outbox_event(
  candidate_key text,
  candidate_name text,
  candidate_occurred_at timestamptz,
  candidate_entity_type text,
  candidate_entity_id text,
  candidate_payload jsonb,
  candidate_command_name text,
  candidate_correlation_id text,
  candidate_available_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE inserted_id uuid;
DECLARE existing domain_outbox_events%ROWTYPE;
BEGIN
  INSERT INTO domain_outbox_events (
    event_id, idempotency_key, event_name, schema_version, occurred_at,
    entity_type, entity_id, payload, command_name, correlation_id, available_at
  ) VALUES (
    gen_random_uuid(), candidate_key, candidate_name, 1,
    candidate_occurred_at, candidate_entity_type, candidate_entity_id,
    candidate_payload, candidate_command_name, candidate_correlation_id,
    GREATEST(candidate_available_at, candidate_occurred_at)
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING event_id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN RETURN true; END IF;

  SELECT * INTO existing FROM domain_outbox_events event
  WHERE event.idempotency_key = candidate_key FOR UPDATE;
  IF existing.event_id IS NULL
      OR existing.event_name IS DISTINCT FROM candidate_name
      OR existing.schema_version IS DISTINCT FROM 1
      OR existing.occurred_at IS DISTINCT FROM candidate_occurred_at
      OR existing.entity_type IS DISTINCT FROM candidate_entity_type
      OR existing.entity_id IS DISTINCT FROM candidate_entity_id
      OR existing.payload IS DISTINCT FROM candidate_payload
      OR existing.command_name IS DISTINCT FROM candidate_command_name
      OR existing.correlation_id IS DISTINCT FROM candidate_correlation_id THEN
    RAISE EXCEPTION 'notification outbox idempotency key collision';
  END IF;
  RETURN false;
END;
$$;

-- Reminder keys can already exist on an upgraded database because 0043 owned
-- this scheduler first. Preserve that event's original scheduling occurrence
-- while still rejecting every semantic collision in the immutable intent.
CREATE FUNCTION insert_exact_invitation_reminder_outbox_event(
  candidate_key text,
  candidate_occurred_at timestamptz,
  candidate_entity_id text,
  candidate_payload jsonb,
  candidate_command_name text,
  candidate_correlation_id text,
  candidate_available_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE inserted_id uuid;
DECLARE existing domain_outbox_events%ROWTYPE;
BEGIN
  INSERT INTO domain_outbox_events (
    event_id, idempotency_key, event_name, schema_version, occurred_at,
    entity_type, entity_id, payload, command_name, correlation_id, available_at
  ) VALUES (
    gen_random_uuid(), candidate_key, 'job_invitation.expiry_reminder', 1,
    candidate_occurred_at, 'JOB_INVITATION', candidate_entity_id,
    candidate_payload, candidate_command_name, candidate_correlation_id,
    GREATEST(candidate_available_at, candidate_occurred_at)
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING event_id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN RETURN true; END IF;

  SELECT * INTO existing FROM domain_outbox_events event
  WHERE event.idempotency_key = candidate_key FOR UPDATE;
  IF existing.event_id IS NULL
      OR existing.event_name IS DISTINCT FROM 'job_invitation.expiry_reminder'
      OR existing.schema_version IS DISTINCT FROM 1
      OR existing.entity_type IS DISTINCT FROM 'JOB_INVITATION'
      OR existing.entity_id IS DISTINCT FROM candidate_entity_id
      OR existing.payload IS DISTINCT FROM candidate_payload
      OR existing.command_name IS DISTINCT FROM candidate_command_name
      OR existing.correlation_id IS DISTINCT FROM candidate_correlation_id THEN
    RAISE EXCEPTION 'invitation reminder outbox idempotency key collision';
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION capture_job_invitation_notification_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind job_invitation_command_kind;
  recipient_id uuid;
  event_name text;
  event_key text;
  command_label text;
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
  ELSIF source_kind = 'ENGAGE' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN customer_profiles profile
      ON profile.id = invitation.customer_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.engaged';
    event_key := 'job-invitation:' || NEW.invitation_id::text || ':engaged';
  ELSIF source_kind = 'DECLINE' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN customer_profiles profile
      ON profile.id = invitation.customer_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.declined';
    event_key := 'job-invitation:' || NEW.invitation_id::text || ':declined';
  ELSIF source_kind = 'CUSTOMER_WITHDRAW' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN craftsman_profiles profile
      ON profile.id = invitation.craftsman_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.withdrawn_by_customer';
    event_key := 'job-invitation:' || NEW.invitation_id::text
      || ':withdrawn-by-customer';
  ELSIF source_kind = 'CRAFTSMAN_WITHDRAW' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN customer_profiles profile
      ON profile.id = invitation.customer_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.withdrawn_by_provider';
    event_key := 'job-invitation:' || NEW.invitation_id::text
      || ':withdrawn-by-provider';
  ELSIF source_kind = 'REQUEST_CLOSED' THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN craftsman_profiles profile
      ON profile.id = invitation.craftsman_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.request_closed';
    event_key := 'job-invitation:' || NEW.invitation_id::text
      || ':request-closed';
  ELSIF source_kind IN ('CUSTOMER_STOP', 'NOT_SELECT') THEN
    SELECT profile.owner_user_id INTO recipient_id
    FROM job_invitations invitation
    JOIN craftsman_profiles profile
      ON profile.id = invitation.craftsman_profile_id
    WHERE invitation.id = NEW.invitation_id;
    event_name := 'job_invitation.not_selected';
    event_key := 'job-invitation:' || NEW.invitation_id::text
      || ':not-selected:' || lower(source_kind::text);
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
  command_label := 'job_invitation.' || lower(source_kind::text);

  PERFORM insert_exact_notification_outbox_event(
    event_key, event_name, NEW.changed_at,
    'JOB_INVITATION', NEW.invitation_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'invitation_revision', NEW.revision
    ),
    command_label, NEW.command_id::text, NEW.changed_at
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION capture_conversation_message_notification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recipient_id uuid;
  invitation_id uuid;
  state conversation_notification_states%ROWTYPE;
BEGIN
  IF NEW.entry_kind <> 'HUMAN_MESSAGE' THEN RETURN NEW; END IF;

  SELECT conversation.invitation_id,
    CASE
      WHEN customer.owner_user_id = NEW.author_user_id
        THEN craftsman.owner_user_id
      WHEN craftsman.owner_user_id = NEW.author_user_id
        THEN customer.owner_user_id
    END
    INTO invitation_id, recipient_id
  FROM conversations conversation
  JOIN job_invitations invitation
    ON invitation.id = conversation.invitation_id
  JOIN customer_profiles customer
    ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman
    ON craftsman.id = invitation.craftsman_profile_id
  WHERE conversation.id = NEW.conversation_id;
  IF recipient_id IS NULL OR invitation_id IS NULL THEN
    RAISE EXCEPTION 'conversation notification recipient missing';
  END IF;

  SELECT * INTO state FROM conversation_notification_states candidate
  WHERE candidate.conversation_id = NEW.conversation_id
    AND candidate.recipient_user_id = recipient_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation notification recipient state missing';
  END IF;
  IF state.muted THEN RETURN NEW; END IF;

  UPDATE conversation_notification_states candidate
  SET latest_notifiable_sequence = NEW.sequence,
      latest_notifiable_at = NEW.created_at,
      updated_at = NEW.created_at
  WHERE candidate.conversation_id = NEW.conversation_id
    AND candidate.recipient_user_id = recipient_id;

  PERFORM insert_exact_notification_outbox_event(
    'conversation:' || NEW.conversation_id::text || ':message:' || NEW.id::text,
    'conversation.message_created', NEW.created_at,
    'CONVERSATION', NEW.conversation_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'invitation_id', invitation_id::text,
      'conversation_sequence', NEW.sequence
    ),
    'conversation.send_message', NEW.message_command_id::text, NEW.created_at
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_message_notification_event_capture
AFTER INSERT ON conversation_timeline_entries
FOR EACH ROW EXECUTE FUNCTION capture_conversation_message_notification_event();

-- This relation is the authorization provenance for opening an exact material
-- update from an invitation notification. The generic operational outbox is
-- deliberately not an authorization authority.
CREATE TABLE job_request_material_update_entitlements (
  invitation_id uuid NOT NULL
    REFERENCES job_invitations(id) ON DELETE RESTRICT,
  job_request_id uuid NOT NULL,
  request_content_revision integer NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_visible_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (invitation_id, request_content_revision),
  FOREIGN KEY (job_request_id, request_content_revision)
    REFERENCES job_request_active_content_revisions(
      job_request_id, content_revision
    ) ON DELETE RESTRICT,
  CONSTRAINT job_request_material_update_entitlement_version_positive CHECK (
    request_visible_version > 0
  )
);

CREATE FUNCTION validate_job_request_material_update_entitlement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authoritative_request_id uuid;
  authoritative_recipient_id uuid;
  authoritative_visible_version integer;
  authoritative_changed_at timestamptz;
  authoritative_material_change boolean;
  authoritative_invitation_state job_invitation_state;
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'material update entitlement is DB-derived';
  END IF;

  SELECT invitation.job_request_id, profile.owner_user_id, current.state
    INTO authoritative_request_id, authoritative_recipient_id,
      authoritative_invitation_state
  FROM job_invitations invitation
  JOIN craftsman_profiles profile
    ON profile.id = invitation.craftsman_profile_id
  JOIN current_job_invitations current ON current.id = invitation.id
  WHERE invitation.id = NEW.invitation_id;
  SELECT revision.visible_version, revision.changed_at,
      revision.material_change
    INTO authoritative_visible_version, authoritative_changed_at,
      authoritative_material_change
  FROM job_request_active_content_revisions revision
  WHERE revision.job_request_id = authoritative_request_id
    AND revision.content_revision = NEW.request_content_revision;

  IF authoritative_request_id IS NULL
      OR authoritative_recipient_id IS NULL
      OR authoritative_visible_version IS NULL
      OR NOT authoritative_material_change
      OR authoritative_invitation_state NOT IN ('PENDING', 'ENGAGED') THEN
    RAISE EXCEPTION 'material update entitlement provenance is invalid';
  END IF;
  NEW.job_request_id := authoritative_request_id;
  NEW.recipient_user_id := authoritative_recipient_id;
  NEW.request_visible_version := authoritative_visible_version;
  NEW.created_at := authoritative_changed_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_request_material_update_entitlements_guard
BEFORE INSERT ON job_request_material_update_entitlements
FOR EACH ROW EXECUTE FUNCTION validate_job_request_material_update_entitlement();

CREATE FUNCTION reject_job_request_material_update_entitlement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'material update entitlement is append-only'; END;
$$;
CREATE TRIGGER job_request_material_update_entitlements_append_only
BEFORE UPDATE OR DELETE ON job_request_material_update_entitlements
FOR EACH ROW EXECUTE FUNCTION reject_job_request_material_update_entitlement_mutation();

CREATE FUNCTION capture_job_request_material_update_notification_events()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.material_change OR NEW.command_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO job_request_material_update_entitlements (
    invitation_id, job_request_id, request_content_revision,
    recipient_user_id, request_visible_version, created_at
  )
  SELECT invitation.id, NEW.job_request_id, NEW.content_revision,
    profile.owner_user_id, NEW.visible_version, NEW.changed_at
  FROM current_job_invitations invitation
  JOIN craftsman_profiles profile
    ON profile.id = invitation.craftsman_profile_id
  WHERE invitation.job_request_id = NEW.job_request_id
    AND invitation.state IN ('PENDING', 'ENGAGED');

  PERFORM insert_exact_notification_outbox_event(
    'job-request:' || NEW.job_request_id::text || ':visible:'
      || NEW.visible_version::text || ':invitation:' || invitation.id::text,
    'job_request.materially_updated', NEW.changed_at,
    'JOB_REQUEST', NEW.job_request_id::text,
    jsonb_build_object(
      'recipient_user_id', profile.owner_user_id::text,
      'invitation_id', invitation.id::text,
      'request_content_revision', NEW.content_revision,
      'request_visible_version', NEW.visible_version
    ),
    'job_request.edit_active', NEW.command_id::text, NEW.changed_at
  )
  FROM current_job_invitations invitation
  JOIN craftsman_profiles profile
    ON profile.id = invitation.craftsman_profile_id
  WHERE invitation.job_request_id = NEW.job_request_id
    AND invitation.state IN ('PENDING', 'ENGAGED')
  ;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_request_material_update_notification_event_capture
AFTER INSERT ON job_request_active_content_revisions
FOR EACH ROW EXECUTE FUNCTION capture_job_request_material_update_notification_events();

CREATE FUNCTION capture_quote_notification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recipient_id uuid;
  customer_recipient_id uuid;
  provider_recipient_id uuid;
  invitation_id uuid;
  request_id uuid;
  event_name text;
  command_label text;
  correlation text;
BEGIN
  IF NEW.state NOT IN ('SUBMITTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED') THEN
    RETURN NEW;
  END IF;

  SELECT invitation.id, invitation.job_request_id,
    customer.owner_user_id, craftsman.owner_user_id
    INTO invitation_id, request_id, customer_recipient_id,
      provider_recipient_id
  FROM quotes quote
  JOIN job_invitations invitation ON invitation.id = quote.invitation_id
  JOIN customer_profiles customer
    ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman
    ON craftsman.id = invitation.craftsman_profile_id
  WHERE quote.id = NEW.quote_id;
  IF customer_recipient_id IS NULL OR provider_recipient_id IS NULL
      OR invitation_id IS NULL OR request_id IS NULL THEN
    RAISE EXCEPTION 'Quote notification recipient missing';
  END IF;
  recipient_id := CASE WHEN NEW.state = 'REJECTED'
    THEN provider_recipient_id ELSE customer_recipient_id END;

  event_name := CASE NEW.state
    WHEN 'SUBMITTED' THEN CASE WHEN NEW.quote_revision = 1
      THEN 'quote.submitted' ELSE 'quote.revised' END
    WHEN 'REJECTED' THEN 'quote.rejected'
    WHEN 'WITHDRAWN' THEN 'quote.withdrawn'
    WHEN 'EXPIRED' THEN 'quote.expired'
  END;
  command_label := CASE WHEN NEW.lifecycle_command_id IS NULL
    THEN 'quote.core' ELSE 'quote.lifecycle' END;
  correlation := coalesce(
    NEW.command_id::text, NEW.lifecycle_command_id::text
  );

  PERFORM insert_exact_notification_outbox_event(
    'quote:' || NEW.quote_id::text || ':revision:'
      || NEW.quote_revision::text || ':state:' || lower(NEW.state::text)
      || ':' || NEW.state_revision::text || ':'
      || CASE WHEN NEW.state = 'EXPIRED' THEN 'customer' ELSE 'recipient' END,
    event_name, NEW.changed_at, 'QUOTE', NEW.quote_id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'invitation_id', invitation_id::text,
      'job_request_id', request_id::text,
      'quote_revision', NEW.quote_revision,
      'recipient_audience', CASE WHEN NEW.state = 'REJECTED'
        THEN 'PROVIDER' ELSE 'CUSTOMER' END
    ),
    command_label, correlation, NEW.changed_at
  );

  IF NEW.state = 'EXPIRED' THEN
    PERFORM insert_exact_notification_outbox_event(
      'quote:' || NEW.quote_id::text || ':revision:'
        || NEW.quote_revision::text || ':state:expired:'
        || NEW.state_revision::text || ':provider',
      event_name, NEW.changed_at, 'QUOTE', NEW.quote_id::text,
      jsonb_build_object(
        'recipient_user_id', provider_recipient_id::text,
        'invitation_id', invitation_id::text,
        'job_request_id', request_id::text,
        'quote_revision', NEW.quote_revision,
        'recipient_audience', 'PROVIDER'
      ),
      command_label, correlation, NEW.changed_at
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quote_notification_event_capture
AFTER INSERT ON quote_revision_state_events
FOR EACH ROW EXECUTE FUNCTION capture_quote_notification_event();

CREATE TABLE conversation_notification_email_batches (
  batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  through_sequence bigint NOT NULL,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE RESTRICT,
  scheduled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (conversation_id, recipient_user_id)
    REFERENCES conversation_notification_states(
      conversation_id, recipient_user_id
    ) ON DELETE RESTRICT,
  CONSTRAINT conversation_notification_email_batch_sequence CHECK (
    through_sequence > 0
  ),
  CONSTRAINT conversation_notification_email_batch_once UNIQUE (
    conversation_id, recipient_user_id, through_sequence
  )
);

CREATE FUNCTION validate_conversation_notification_email_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state conversation_notification_states%ROWTYPE;
  target notifications%ROWTYPE;
  delay_seconds integer;
BEGIN
  SELECT * INTO state FROM conversation_notification_states candidate
  WHERE candidate.conversation_id = NEW.conversation_id
    AND candidate.recipient_user_id = NEW.recipient_user_id
  FOR UPDATE;
  SELECT chat_email_delay_seconds INTO delay_seconds
  FROM demand_notification_runtime_policy WHERE singleton;
  IF state.conversation_id IS NULL OR delay_seconds IS NULL
      OR state.muted OR state.latest_notifiable_sequence <= state.last_read_sequence
      OR state.latest_notifiable_sequence
        <= state.email_considered_through_sequence
      OR state.latest_notifiable_at IS NULL
      OR state.latest_notifiable_at
        > clock_timestamp() - make_interval(secs => delay_seconds) THEN
    RAISE EXCEPTION 'chat email batch is not due';
  END IF;

  SELECT * INTO target FROM notifications notification
  WHERE notification.recipient_user_id = state.recipient_user_id
    AND notification.type = 'conversation.message_received'
    AND notification.entity_type = 'CONVERSATION'
    AND notification.entity_id = state.conversation_id::text
    AND notification.entity_revision = state.latest_notifiable_sequence
  FOR UPDATE;
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'chat email batch requires exact in-app notification';
  END IF;
  IF EXISTS (
    SELECT 1 FROM conversation_notification_email_batches prior
    WHERE prior.conversation_id = state.conversation_id
      AND prior.recipient_user_id = state.recipient_user_id
      AND prior.through_sequence >= state.latest_notifiable_sequence
  ) THEN
    RAISE EXCEPTION 'chat email batch was already scheduled';
  END IF;

  NEW.batch_id := gen_random_uuid();
  NEW.through_sequence := state.latest_notifiable_sequence;
  NEW.notification_id := target.id;
  NEW.scheduled_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_notification_email_batches_guard
BEFORE INSERT ON conversation_notification_email_batches
FOR EACH ROW EXECUTE FUNCTION validate_conversation_notification_email_batch();

CREATE FUNCTION enqueue_conversation_notification_email_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inserted_id uuid;
DECLARE existing notification_deliveries%ROWTYPE;
DECLARE delivery_key text;
BEGIN
  delivery_key := NEW.notification_id::text || ':'
    || NEW.recipient_user_id::text
    || ':conversation.message_received:EMAIL';
  INSERT INTO notification_deliveries (
    notification_id, channel, idempotency_key, available_at
  ) VALUES (
    NEW.notification_id, 'EMAIL',
    delivery_key,
    NEW.scheduled_at
  ) ON CONFLICT (notification_id, channel) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT * INTO existing FROM notification_deliveries delivery
    WHERE delivery.notification_id = NEW.notification_id
      AND delivery.channel = 'EMAIL'
    FOR UPDATE;
    IF existing.id IS NULL
        OR existing.idempotency_key IS DISTINCT FROM delivery_key THEN
      RAISE EXCEPTION 'chat email delivery intent collision';
    END IF;
  END IF;
  UPDATE conversation_notification_states state
  SET email_considered_through_sequence = greatest(
        state.email_considered_through_sequence, NEW.through_sequence
      ),
      updated_at = NEW.scheduled_at
  WHERE state.conversation_id = NEW.conversation_id
    AND state.recipient_user_id = NEW.recipient_user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_notification_email_batch_enqueues_delivery
AFTER INSERT ON conversation_notification_email_batches
FOR EACH ROW EXECUTE FUNCTION enqueue_conversation_notification_email_delivery();

CREATE FUNCTION reject_conversation_notification_email_batch_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'chat email batch history is append-only'; END;
$$;
CREATE TRIGGER conversation_notification_email_batches_append_only
BEFORE UPDATE OR DELETE ON conversation_notification_email_batches
FOR EACH ROW EXECUTE FUNCTION reject_conversation_notification_email_batch_mutation();

CREATE INDEX conversation_notification_email_batches_recipient_idx
  ON conversation_notification_email_batches (
    recipient_user_id, scheduled_at DESC, batch_id
  );

COMMENT ON TABLE conversation_notification_states IS
  'DB-derived privacy-minimal mute/read/message serialization state. Lock order is command advisory, recipient notification state, conversation/invitation context, then message/participant history.';
COMMENT ON TABLE conversation_notification_email_batches IS
  'Append-only delayed generic chat email batching provenance; contains no message content.';
COMMENT ON FUNCTION capture_job_request_material_update_notification_events() IS
  'Fans out only material active-request versions to current PENDING/ENGAGED invitations without request content.';
COMMENT ON FUNCTION capture_quote_notification_event() IS
  'Captures privacy-minimal Quote state events atomically; delivery remains asynchronous and cannot roll back Quote state.';
