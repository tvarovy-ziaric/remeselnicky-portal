CREATE TYPE outbox_event_status AS ENUM (
  'PENDING',
  'PROCESSING',
  'PUBLISHED',
  'TERMINAL'
);

CREATE FUNCTION outbox_payload_is_minimal(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(candidate) <> 'object' THEN false
    ELSE (
      SELECT count(*) <= 64
      FROM jsonb_object_keys(candidate)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(candidate) AS item(key, value)
      WHERE
        item.key !~ '^[a-z][a-z0-9_]{0,63}$'
        OR item.key IN (
          'address', 'body', 'chat_text', 'content', 'cookie', 'coordinates',
          'description', 'dispute_text', 'email', 'exact_address', 'filename',
          'latitude', 'longitude', 'message_text', 'otp', 'password', 'phone',
          'quote_text', 'review_text', 'secret', 'token'
        )
        OR CASE jsonb_typeof(item.value)
          WHEN 'string' THEN
            (item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'
          WHEN 'number' THEN false
          WHEN 'boolean' THEN false
          WHEN 'null' THEN false
          WHEN 'array' THEN
            jsonb_array_length(item.value) > 64
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(item.value) AS element(value)
              WHERE
                jsonb_typeof(element.value) NOT IN (
                  'string',
                  'number',
                  'boolean',
                  'null'
                )
                OR (
                  jsonb_typeof(element.value) = 'string'
                  AND (element.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'
                )
            )
          ELSE true
        END
    )
  END
$$;

CREATE TABLE domain_outbox_events (
  event_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL,
  event_name text NOT NULL,
  schema_version smallint NOT NULL,
  occurred_at timestamptz NOT NULL,
  entity_type text,
  entity_id text,
  payload jsonb NOT NULL,
  command_name text NOT NULL,
  correlation_id text NOT NULL,
  status outbox_event_status NOT NULL DEFAULT 'PENDING',
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  published_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT domain_outbox_events_idempotency_key_unique
    UNIQUE (idempotency_key),
  CONSTRAINT domain_outbox_events_idempotency_key_bounded
    CHECK (
      length(idempotency_key) BETWEEN 1 AND 256
      AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'
    ),
  CONSTRAINT domain_outbox_events_name_stable
    CHECK (
      length(event_name) BETWEEN 1 AND 128
      AND event_name ~ '^[a-z][a-z0-9]*([._][a-z0-9]+)*$'
    ),
  CONSTRAINT domain_outbox_events_schema_version_valid
    CHECK (schema_version BETWEEN 1 AND 32767),
  CONSTRAINT domain_outbox_events_entity_complete
    CHECK (
      (entity_type IS NULL AND entity_id IS NULL)
      OR (
        entity_type IS NOT NULL
        AND entity_id IS NOT NULL
        AND entity_type ~ '^[A-Z][A-Z0-9_]{0,79}$'
        AND length(entity_id) BETWEEN 1 AND 128
        AND entity_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
      )
    ),
  CONSTRAINT domain_outbox_events_payload_object_bounded
    CHECK (
      outbox_payload_is_minimal(payload)
      AND octet_length(payload::text) <= 8192
    ),
  CONSTRAINT domain_outbox_events_command_name_stable
    CHECK (
      length(command_name) BETWEEN 1 AND 128
      AND command_name ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
    ),
  CONSTRAINT domain_outbox_events_correlation_id_bounded
    CHECK (
      length(correlation_id) BETWEEN 1 AND 256
      AND correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'
    ),
  CONSTRAINT domain_outbox_events_attempt_count_valid
    CHECK (attempt_count >= 0),
  CONSTRAINT domain_outbox_events_error_code_safe
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'
    ),
  CONSTRAINT domain_outbox_events_delivery_state_consistent
    CHECK (
      (
        status = 'PENDING'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND published_at IS NULL
        AND terminal_at IS NULL
      )
      OR (
        status = 'PROCESSING'
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND published_at IS NULL
        AND terminal_at IS NULL
      )
      OR (
        status = 'PUBLISHED'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND published_at IS NOT NULL
        AND terminal_at IS NULL
      )
      OR (
        status = 'TERMINAL'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND published_at IS NULL
        AND terminal_at IS NOT NULL
        AND last_error_code IS NOT NULL
      )
    ),
  CONSTRAINT domain_outbox_events_timestamps_ordered
    CHECK (
      updated_at >= created_at
      AND available_at >= occurred_at
      AND (lease_expires_at IS NULL OR lease_expires_at > updated_at)
      AND (published_at IS NULL OR published_at >= occurred_at)
      AND (terminal_at IS NULL OR terminal_at >= occurred_at)
    )
);

CREATE INDEX domain_outbox_events_pending_idx
  ON domain_outbox_events (available_at, occurred_at, event_id)
  WHERE status = 'PENDING';

CREATE INDEX domain_outbox_events_expired_lease_idx
  ON domain_outbox_events (lease_expires_at, occurred_at, event_id)
  WHERE status = 'PROCESSING';

CREATE INDEX domain_outbox_events_terminal_idx
  ON domain_outbox_events (terminal_at, event_name)
  WHERE status = 'TERMINAL';

CREATE TABLE outbox_consumer_effects (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL REFERENCES domain_outbox_events(event_id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (consumer_name, event_id),
  CONSTRAINT outbox_consumer_effects_consumer_name_stable
    CHECK (
      length(consumer_name) BETWEEN 1 AND 128
      AND consumer_name ~ '^[a-z][a-z0-9]*([._:-][a-z0-9]+)*$'
    )
);

CREATE INDEX outbox_consumer_effects_event_idx
  ON outbox_consumer_effects (event_id, applied_at);
