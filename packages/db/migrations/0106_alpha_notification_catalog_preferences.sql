-- R4-024 / D25: complete alpha notification event capture and user controls.
-- In-app remains canonical. Optional email preferences are evaluated only when
-- a notification is materialized; required transactional/security email wins.
CREATE TYPE notification_category AS ENUM (
  'CHAT', 'MARKETPLACE', 'JOB_OPERATIONS', 'REVIEWS', 'ACCOUNT_SECURITY'
);

CREATE TABLE notification_channel_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category notification_category NOT NULL,
  channel notification_channel NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, category, channel),
  CONSTRAINT notification_preference_mutable_channels_only
    CHECK (channel IN ('EMAIL', 'PUSH'))
);

ALTER TABLE notifications
ADD COLUMN requested_channels notification_channel[] NOT NULL
  DEFAULT ARRAY['IN_APP']::notification_channel[];
ALTER TABLE notifications
ADD COLUMN delivery_channels notification_channel[] NOT NULL
  DEFAULT ARRAY['IN_APP']::notification_channel[];

UPDATE notifications notification
SET requested_channels = ARRAY(
  SELECT requested.channel::notification_channel
  FROM unnest(ARRAY['IN_APP', 'EMAIL', 'PUSH']::text[]) WITH ORDINALITY
    AS requested(channel, ordinal)
  WHERE requested.channel = 'IN_APP'
    OR EXISTS (
      SELECT 1 FROM notification_deliveries delivery
      WHERE delivery.notification_id = notification.id
        AND delivery.channel::text = requested.channel
    )
  ORDER BY requested.ordinal
);
UPDATE notifications SET delivery_channels = requested_channels;

ALTER TABLE notifications
ADD CONSTRAINT notifications_requested_channels_valid CHECK (
  requested_channels @> ARRAY['IN_APP']::notification_channel[]
  AND requested_channels <@ ARRAY['IN_APP', 'EMAIL', 'PUSH']::notification_channel[]
  AND cardinality(requested_channels) BETWEEN 1 AND 3
);
ALTER TABLE notifications
ADD CONSTRAINT notifications_delivery_channels_valid CHECK (
  delivery_channels @> ARRAY['IN_APP']::notification_channel[]
  AND delivery_channels <@ requested_channels
  AND cardinality(delivery_channels) BETWEEN 1 AND 3
);

CREATE OR REPLACE FUNCTION protect_notification_business_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.recipient_user_id <> OLD.recipient_user_id
    OR NEW.type <> OLD.type
    OR NEW.domain_event_id <> OLD.domain_event_id
    OR NEW.event_idempotency_key <> OLD.event_idempotency_key
    OR NEW.entity_type <> OLD.entity_type
    OR NEW.entity_id <> OLD.entity_id
    OR NEW.entity_revision IS DISTINCT FROM OLD.entity_revision
    OR NEW.deep_link_path <> OLD.deep_link_path
    OR NEW.priority <> OLD.priority
    OR NEW.payload <> OLD.payload
    OR NEW.requested_channels <> OLD.requested_channels
    OR NEW.delivery_channels <> OLD.delivery_channels
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'notification provenance and content are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION capture_confirmed_job_notification_events()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer_user_id uuid;
DECLARE provider_user_id uuid;
BEGIN
  SELECT customer.owner_user_id, provider.owner_user_id
    INTO customer_user_id, provider_user_id
  FROM customer_profiles customer
  JOIN craftsman_profiles provider ON provider.id = NEW.primary_craftsman_profile_id
  WHERE customer.id = NEW.customer_profile_id;
  IF customer_user_id IS NULL OR provider_user_id IS NULL
      OR customer_user_id IS NOT DISTINCT FROM provider_user_id THEN
    RAISE EXCEPTION 'distinct confirmed Job parties required';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'job:' || NEW.id::text || ':confirmed:' || customer_user_id::text,
    'job.confirmed', NEW.accepted_at, 'JOB', NEW.id::text,
    jsonb_build_object('job_id', NEW.id::text,
      'recipient_user_id', customer_user_id::text),
    'job.confirmed', NEW.acceptance_command_id::text, NEW.accepted_at
  );
  PERFORM insert_exact_notification_outbox_event(
    'job:' || NEW.id::text || ':confirmed:' || provider_user_id::text,
    'job.confirmed', NEW.accepted_at, 'JOB', NEW.id::text,
    jsonb_build_object('job_id', NEW.id::text,
      'recipient_user_id', provider_user_id::text),
    'job.confirmed', NEW.acceptance_command_id::text, NEW.accepted_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER jobs_capture_confirmed_notification_events
AFTER INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION capture_confirmed_job_notification_events();

CREATE FUNCTION capture_review_response_notification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_author_id uuid;
BEGIN
  SELECT review.actor_user_id INTO review_author_id
  FROM job_main_review_events review
  WHERE review.event_id = NEW.review_revision_id;
  IF review_author_id IS NULL OR review_author_id IS NOT DISTINCT FROM NEW.author_user_id THEN
    RAISE EXCEPTION 'distinct review author required for response notification';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'review-response:' || NEW.response_id::text || ':created',
    'job.review.response.created', NEW.created_at,
    'REVIEW_RESPONSE', NEW.response_id::text,
    jsonb_build_object('job_id', NEW.job_id::text,
      'recipient_user_id', review_author_id::text,
      'response_id', NEW.response_id::text),
    'job.review.response.created', NEW.create_command_id::text, NEW.created_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_main_review_responses_capture_notification
AFTER INSERT ON job_main_review_responses
FOR EACH ROW EXECUTE FUNCTION capture_review_response_notification_event();

CREATE FUNCTION capture_credential_decision_notification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
DECLARE event_name text;
BEGIN
  IF NEW.command_kind NOT IN ('APPROVE', 'REJECT', 'REVOKE') THEN RETURN NULL; END IF;
  SELECT profile.owner_user_id INTO recipient_id
  FROM craftsman_profiles profile WHERE profile.id = NEW.craftsman_profile_id;
  IF recipient_id IS NULL THEN RAISE EXCEPTION 'credential owner required'; END IF;
  event_name := CASE NEW.command_kind
    WHEN 'APPROVE' THEN 'credential.approved'
    WHEN 'REJECT' THEN 'credential.rejected'
    ELSE 'credential.revoked'
  END;
  PERFORM insert_exact_notification_outbox_event(
    'credential:' || NEW.claim_id::text || ':' || lower(NEW.command_kind::text),
    event_name, NEW.occurred_at, 'CREDENTIAL_CLAIM', NEW.claim_id::text,
    jsonb_build_object('claim_id', NEW.claim_id::text,
      'decision', NEW.command_kind::text,
      'reason_category', NEW.reason_category,
      'recipient_user_id', recipient_id::text),
    event_name, NEW.command_id::text, NEW.occurred_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER credential_claim_commands_capture_notification
AFTER INSERT ON credential_claim_commands
FOR EACH ROW EXECUTE FUNCTION capture_credential_decision_notification_event();

CREATE FUNCTION capture_profile_decision_notification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
DECLARE event_name text;
DECLARE decision text;
DECLARE safe_reason_code text;
BEGIN
  IF NEW.command_kind NOT IN ('ADMIN_APPROVE', 'ADMIN_REJECT') THEN RETURN NULL; END IF;
  SELECT profile.owner_user_id INTO recipient_id
  FROM craftsman_profiles profile WHERE profile.id = NEW.craftsman_profile_id;
  IF recipient_id IS NULL THEN RAISE EXCEPTION 'profile owner required'; END IF;
  IF NEW.command_kind = 'ADMIN_APPROVE' THEN
    event_name := 'profile.approved'; decision := 'APPROVED'; safe_reason_code := NULL;
  ELSE
    event_name := 'profile.rejected'; decision := 'REJECTED';
    safe_reason_code := NEW.rejection_reason_code;
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'profile:' || NEW.craftsman_profile_id::text || ':decision:' || NEW.resulting_revision::text,
    event_name, NEW.created_at, 'CRAFTSMAN_PROFILE', NEW.craftsman_profile_id::text,
    jsonb_build_object('decision', decision,
      'profile_id', NEW.craftsman_profile_id::text,
      'reason_code', safe_reason_code,
      'recipient_user_id', recipient_id::text),
    event_name, NEW.command_id::text, NEW.created_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER craftsman_profile_publication_capture_notification
AFTER INSERT ON craftsman_profile_publication_commands
FOR EACH ROW EXECUTE FUNCTION capture_profile_decision_notification_event();

-- A global CHAT email opt-out composes with the existing per-conversation mute.
CREATE OR REPLACE FUNCTION validate_conversation_notification_email_batch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state conversation_notification_states%ROWTYPE;
DECLARE target notifications%ROWTYPE;
DECLARE delay_seconds integer;
BEGIN
  SELECT * INTO state FROM conversation_notification_states candidate
  WHERE candidate.conversation_id = NEW.conversation_id
    AND candidate.recipient_user_id = NEW.recipient_user_id FOR UPDATE;
  SELECT chat_email_delay_seconds INTO delay_seconds
  FROM demand_notification_runtime_policy WHERE singleton;
  IF state.conversation_id IS NULL OR delay_seconds IS NULL OR state.muted
      OR EXISTS (SELECT 1 FROM notification_channel_preferences preference
        WHERE preference.user_id = NEW.recipient_user_id
          AND preference.category = 'CHAT' AND preference.channel = 'EMAIL'
          AND NOT preference.enabled)
      OR state.latest_notifiable_sequence <= state.last_read_sequence
      OR state.latest_notifiable_sequence <= state.email_considered_through_sequence
      OR state.latest_notifiable_at IS NULL
      OR state.latest_notifiable_at > clock_timestamp()
        - make_interval(secs => delay_seconds) THEN
    RAISE EXCEPTION 'chat email batch is not due';
  END IF;
  SELECT * INTO target FROM notifications notification
  WHERE notification.recipient_user_id = state.recipient_user_id
    AND notification.type = 'conversation.message_received'
    AND notification.entity_type = 'CONVERSATION'
    AND notification.entity_id = state.conversation_id::text
    AND notification.entity_revision = state.latest_notifiable_sequence FOR UPDATE;
  IF target.id IS NULL THEN RAISE EXCEPTION 'chat email batch requires exact in-app notification'; END IF;
  IF EXISTS (SELECT 1 FROM conversation_notification_email_batches prior
    WHERE prior.conversation_id = state.conversation_id
      AND prior.recipient_user_id = state.recipient_user_id
      AND prior.through_sequence >= state.latest_notifiable_sequence) THEN
    RAISE EXCEPTION 'chat email batch was already scheduled';
  END IF;
  NEW.batch_id := gen_random_uuid(); NEW.through_sequence := state.latest_notifiable_sequence;
  NEW.notification_id := target.id; NEW.scheduled_at := clock_timestamp();
  RETURN NEW;
END;
$$;

COMMENT ON TABLE notification_channel_preferences IS
  'Per-user channel/category controls. In-app is deliberately absent and always canonical; required email overrides are enforced by the notification catalog.';
COMMENT ON COLUMN notifications.requested_channels IS
  'Immutable producer channel intent before user preference filtering; supports replay-safe deduplication.';
COMMENT ON COLUMN notifications.delivery_channels IS
  'Immutable channel set selected from producer intent under the preference and required-delivery policy at creation time.';
