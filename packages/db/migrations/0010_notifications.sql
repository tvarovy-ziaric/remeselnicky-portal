CREATE TYPE notification_priority AS ENUM ('INFO', 'IMPORTANT', 'CRITICAL');
CREATE TYPE notification_channel AS ENUM ('IN_APP', 'EMAIL', 'PUSH');
CREATE TYPE notification_delivery_state AS ENUM (
  'QUEUED',
  'PROCESSING',
  'SENT',
  'DELIVERED',
  'TERMINAL_FAILED'
);

CREATE FUNCTION notification_payload_is_safe(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT
    jsonb_typeof(candidate) = 'object'
    AND pg_column_size(candidate) <= 2048
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(candidate) AS member(key, value)
      WHERE
        member.key !~ '^[a-z][a-z0-9_]{0,63}$'
        OR lower(member.key) IN (
          'address', 'body', 'chat_text', 'content', 'cookie', 'coordinates',
          'description', 'dispute_text', 'email', 'exact_address', 'filename',
          'latitude', 'longitude', 'message_text', 'otp', 'password', 'phone',
          'quote_text', 'review_text', 'secret', 'token'
        )
        OR CASE jsonb_typeof(member.value)
          WHEN 'null' THEN false
          WHEN 'boolean' THEN false
          WHEN 'number' THEN false
          WHEN 'string' THEN (member.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'
          WHEN 'array' THEN
            jsonb_array_length(member.value) > 32
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(member.value) AS element(value)
              WHERE
                jsonb_typeof(element.value) NOT IN ('null', 'boolean', 'number', 'string')
                OR (
                  jsonb_typeof(element.value) = 'string'
                  AND (element.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'
                )
            )
          ELSE true
        END
    );
$$;

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type text NOT NULL,
  domain_event_id uuid NOT NULL REFERENCES domain_outbox_events(event_id) ON DELETE RESTRICT,
  event_idempotency_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_revision integer,
  deep_link_path text NOT NULL,
  priority notification_priority NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT notifications_type_valid CHECK (
    length(type) <= 128
    AND type ~ '^[a-z][a-z0-9]*([._][a-z0-9]+)*$'
  ),
  CONSTRAINT notifications_event_key_valid CHECK (
    length(event_idempotency_key) <= 256
    AND event_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
  ),
  CONSTRAINT notifications_entity_type_valid CHECK (
    entity_type ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  CONSTRAINT notifications_entity_id_valid CHECK (
    length(entity_id) <= 128
    AND entity_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
  ),
  CONSTRAINT notifications_entity_revision_valid CHECK (
    entity_revision IS NULL OR entity_revision > 0
  ),
  CONSTRAINT notifications_deep_link_is_safe_path CHECK (
    length(deep_link_path) BETWEEN 2 AND 512
    AND deep_link_path ~ '^/[A-Za-z0-9/_-]+$'
    AND deep_link_path !~ '//'
  ),
  CONSTRAINT notifications_payload_is_safe CHECK (
    notification_payload_is_safe(payload)
  ),
  CONSTRAINT notifications_state_timestamps_ordered CHECK (
    (read_at IS NULL OR read_at >= created_at)
    AND (archived_at IS NULL OR archived_at >= created_at)
  ),
  CONSTRAINT notifications_event_recipient_type_unique
    UNIQUE (domain_event_id, recipient_user_id, type)
);

CREATE INDEX notifications_recipient_created_idx
  ON notifications (recipient_user_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX notifications_recipient_unread_idx
  ON notifications (recipient_user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL AND archived_at IS NULL;

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel notification_channel NOT NULL,
  state notification_delivery_state NOT NULL DEFAULT 'QUEUED',
  idempotency_key text NOT NULL UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  provider_message_reference text,
  sent_at timestamptz,
  delivered_at timestamptz,
  terminal_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notification_deliveries_channel_unique
    UNIQUE (notification_id, channel),
  CONSTRAINT notification_deliveries_idempotency_key_valid CHECK (
    length(idempotency_key) BETWEEN 1 AND 256
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
  ),
  CONSTRAINT notification_deliveries_attempt_count_valid CHECK (
    attempt_count >= 0
  ),
  CONSTRAINT notification_deliveries_error_code_valid CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'
  ),
  CONSTRAINT notification_deliveries_provider_reference_bounded CHECK (
    provider_message_reference IS NULL
    OR (
      length(provider_message_reference) BETWEEN 1 AND 512
      AND provider_message_reference ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
    )
  ),
  CONSTRAINT notification_deliveries_lease_matches_state CHECK (
    (state = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT notification_deliveries_result_matches_state CHECK (
    (state = 'QUEUED' AND sent_at IS NULL AND delivered_at IS NULL AND terminal_failed_at IS NULL)
    OR (state = 'PROCESSING' AND delivered_at IS NULL AND terminal_failed_at IS NULL)
    OR (state = 'SENT' AND sent_at IS NOT NULL AND delivered_at IS NULL AND terminal_failed_at IS NULL)
    OR (state = 'DELIVERED' AND sent_at IS NOT NULL AND delivered_at IS NOT NULL AND terminal_failed_at IS NULL)
    OR (state = 'TERMINAL_FAILED' AND delivered_at IS NULL AND terminal_failed_at IS NOT NULL)
  ),
  CONSTRAINT notification_deliveries_timestamps_ordered CHECK (
    available_at >= created_at
    AND updated_at >= created_at
    AND (lease_expires_at IS NULL OR lease_expires_at > updated_at)
    AND (sent_at IS NULL OR sent_at >= created_at)
    AND (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at))
    AND (terminal_failed_at IS NULL OR terminal_failed_at >= created_at)
  )
);

CREATE INDEX notification_email_delivery_ready_idx
  ON notification_deliveries (available_at, created_at, id)
  WHERE channel = 'EMAIL' AND state IN ('QUEUED', 'PROCESSING');

CREATE INDEX notification_email_delivery_expired_lease_idx
  ON notification_deliveries (lease_expires_at, id)
  WHERE channel = 'EMAIL' AND state = 'PROCESSING';

CREATE INDEX notification_delivery_terminal_idx
  ON notification_deliveries (terminal_failed_at, id)
  WHERE state = 'TERMINAL_FAILED';

CREATE FUNCTION protect_notification_business_fields()
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
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'notification provenance and content are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_protect_business_fields
BEFORE UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION protect_notification_business_fields();

CREATE FUNCTION enforce_notification_delivery_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> NEW.state AND NOT (
    (OLD.state = 'QUEUED' AND NEW.state = 'PROCESSING')
    OR (OLD.state = 'PROCESSING' AND NEW.state IN (
      'QUEUED', 'SENT', 'DELIVERED', 'TERMINAL_FAILED'
    ))
    OR (OLD.state = 'SENT' AND NEW.state IN ('DELIVERED', 'TERMINAL_FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid notification delivery state transition: % -> %',
      OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_deliveries_enforce_transition
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION enforce_notification_delivery_transition();
