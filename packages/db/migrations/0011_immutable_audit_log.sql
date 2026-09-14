CREATE TYPE audit_event_category AS ENUM (
  'PRIVILEGED_COMMAND',
  'SENSITIVE_ACCESS',
  'SECURITY_EVENT'
);

CREATE TYPE audit_actor_kind AS ENUM ('AUTHENTICATED_USER', 'SYSTEM');

CREATE TYPE audit_sensitive_access_purpose AS ENUM (
  'DISPUTE_INVESTIGATION',
  'LEGAL_PRIVACY_REQUEST',
  'MODERATION_REVIEW',
  'SECURITY_INVESTIGATION',
  'SUPPORT_CASE'
);

CREATE OR REPLACE FUNCTION audit_reason_is_safe(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT candidate = btrim(candidate)
    AND length(candidate) BETWEEN 8 AND 500
    AND candidate !~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    AND candidate !~* 'https?://'
    AND candidate !~* 'bearer[[:space:]]+[^[:space:]]+'
    AND candidate !~ '(\+?[0-9][0-9 ().-]{6,}[0-9])'
$$;

CREATE OR REPLACE FUNCTION audit_diff_is_safe(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
DECLARE
  field_name text;
  field_change jsonb;
  value_name text;
  value_kind text;
  scalar_text text;
BEGIN
  IF jsonb_typeof(candidate) <> 'object' THEN
    RETURN false;
  END IF;

  FOR field_name, field_change IN
    SELECT key, value FROM jsonb_each(candidate)
  LOOP
    IF field_name NOT IN (
      'account_state',
      'credential_state',
      'dispute_state',
      'job_state',
      'message_visibility',
      'profile_state',
      'public_visibility',
      'restriction_state',
      'review_visibility',
      'role'
    ) THEN
      RETURN false;
    END IF;

    IF jsonb_typeof(field_change) <> 'object'
      OR NOT field_change ? 'before'
      OR NOT field_change ? 'after'
      OR (SELECT count(*) FROM jsonb_object_keys(field_change)) <> 2
    THEN
      RETURN false;
    END IF;

    FOREACH value_name IN ARRAY ARRAY['before', 'after']
    LOOP
      value_kind := jsonb_typeof(field_change -> value_name);
      IF value_kind IN ('null', 'boolean') THEN
        CONTINUE;
      ELSIF value_kind = 'number' THEN
        scalar_text := field_change ->> value_name;
        IF scalar_text !~ '^-?[0-9]{1,9}$' THEN
          RETURN false;
        END IF;
      ELSIF value_kind = 'string' THEN
        scalar_text := field_change ->> value_name;
        IF scalar_text !~ '^[A-Z][A-Z0-9_.:-]{0,63}$' THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;

  RETURN true;
END;
$$;

CREATE TABLE audit_events (
  event_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  category audit_event_category NOT NULL,
  actor_kind audit_actor_kind NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_system_reference text,
  actor_capability text,
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text,
  sensitive_access_purpose audit_sensitive_access_purpose,
  context_type text,
  context_id text,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_admin_role_change_event_id uuid UNIQUE
    REFERENCES admin_role_change_events(event_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_events_actor_valid CHECK (
    (
      actor_kind = 'AUTHENTICATED_USER'
      AND actor_user_id IS NOT NULL
      AND actor_system_reference IS NULL
      AND actor_capability IS NOT NULL
      AND actor_capability IN (
        'admin.access',
        'admin.credentials.review',
        'admin.disputes.manage',
        'admin.jobs.correct',
        'admin.profiles.review',
        'admin.reviews.moderate',
        'admin.sensitive.read',
        'admin.users.manage',
        'admin.roles.manage'
      )
    )
    OR (
      actor_kind = 'SYSTEM'
      AND actor_user_id IS NULL
      AND actor_system_reference IS NOT NULL
      AND actor_system_reference ~ '^[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      AND actor_capability IS NULL
    )
  ),
  CONSTRAINT audit_events_action_taxonomy CHECK (
    length(action_type) <= 96
    AND action_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'
  ),
  CONSTRAINT audit_events_target_reference_valid CHECK (
    target_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
    AND target_id ~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$'
  ),
  CONSTRAINT audit_events_reason_valid CHECK (
    (
      category IN ('PRIVILEGED_COMMAND', 'SENSITIVE_ACCESS')
      AND reason IS NOT NULL
      AND audit_reason_is_safe(reason)
    )
    OR (category = 'SECURITY_EVENT' AND (reason IS NULL OR audit_reason_is_safe(reason)))
  ),
  CONSTRAINT audit_events_sensitive_context_valid CHECK (
    (
      category = 'SENSITIVE_ACCESS'
      AND sensitive_access_purpose IS NOT NULL
      AND context_type IS NOT NULL
      AND context_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND context_id IS NOT NULL
      AND context_id ~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$'
    )
    OR (
      category <> 'SENSITIVE_ACCESS'
      AND sensitive_access_purpose IS NULL
      AND context_type IS NULL
      AND context_id IS NULL
    )
  ),
  CONSTRAINT audit_events_changes_safe CHECK (audit_diff_is_safe(changes)),
  CONSTRAINT audit_events_role_source_valid CHECK (
    source_admin_role_change_event_id IS NULL
    OR (
      category = 'PRIVILEGED_COMMAND'
      AND actor_kind = 'AUTHENTICATED_USER'
      AND actor_capability = 'admin.roles.manage'
      AND target_type = 'USER'
      AND action_type IN ('admin.role.granted', 'admin.role.revoked')
    )
  )
);

CREATE INDEX audit_events_actor_timeline_idx
  ON audit_events (actor_user_id, occurred_at DESC, event_id)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX audit_events_target_timeline_idx
  ON audit_events (target_type, target_id, occurred_at DESC, event_id);

CREATE INDEX audit_events_correlation_idx
  ON audit_events (correlation_id, occurred_at, event_id);

CREATE INDEX audit_events_sensitive_access_idx
  ON audit_events (occurred_at DESC, event_id)
  WHERE category = 'SENSITIVE_ACCESS';

-- The role-event table remains authoritative. Backfill pre-existing events
-- before the server-time trigger is installed so their original DB timestamps
-- remain intact. Unsafe legacy reason content is not copied into the minimized
-- unified ledger; the source foreign key preserves provenance.
INSERT INTO audit_events (
  event_id,
  correlation_id,
  category,
  actor_kind,
  actor_user_id,
  actor_capability,
  action_type,
  target_type,
  target_id,
  reason,
  changes,
  source_admin_role_change_event_id,
  occurred_at
)
SELECT
  source.event_id,
  source.event_id,
  'PRIVILEGED_COMMAND',
  'AUTHENTICATED_USER',
  source.actor_user_id,
  'admin.roles.manage',
  CASE source.action
    WHEN 'ADMIN_ROLE_GRANTED' THEN 'admin.role.granted'
    ELSE 'admin.role.revoked'
  END,
  'USER',
  source.target_user_id::text,
  CASE
    WHEN audit_reason_is_safe(source.reason) THEN source.reason
    ELSE 'Migrated role event reason withheld by minimization'
  END,
  jsonb_build_object(
    'role',
    jsonb_build_object(
      'before', CASE source.action
        WHEN 'ADMIN_ROLE_REVOKED' THEN to_jsonb(source.role::text)
        ELSE 'null'::jsonb
      END,
      'after', CASE source.action
        WHEN 'ADMIN_ROLE_GRANTED' THEN to_jsonb(source.role::text)
        ELSE 'null'::jsonb
      END
    )
  ),
  source.event_id,
  source.occurred_at
FROM admin_role_change_events AS source
ORDER BY source.occurred_at, source.event_id;

CREATE OR REPLACE FUNCTION set_audit_event_server_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.occurred_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_server_timestamp
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION set_audit_event_server_timestamp();

CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE OR REPLACE FUNCTION mirror_admin_role_change_to_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_events (
    event_id,
    correlation_id,
    category,
    actor_kind,
    actor_user_id,
    actor_capability,
    action_type,
    target_type,
    target_id,
    reason,
    changes,
    source_admin_role_change_event_id
  ) VALUES (
    NEW.event_id,
    NEW.event_id,
    'PRIVILEGED_COMMAND',
    'AUTHENTICATED_USER',
    NEW.actor_user_id,
    'admin.roles.manage',
    CASE NEW.action
      WHEN 'ADMIN_ROLE_GRANTED' THEN 'admin.role.granted'
      ELSE 'admin.role.revoked'
    END,
    'USER',
    NEW.target_user_id::text,
    NEW.reason,
    jsonb_build_object(
      'role',
      jsonb_build_object(
        'before', CASE NEW.action
          WHEN 'ADMIN_ROLE_REVOKED' THEN to_jsonb(NEW.role::text)
          ELSE 'null'::jsonb
        END,
        'after', CASE NEW.action
          WHEN 'ADMIN_ROLE_GRANTED' THEN to_jsonb(NEW.role::text)
          ELSE 'null'::jsonb
        END
      )
    ),
    NEW.event_id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER admin_role_change_audit_mirror
AFTER INSERT ON admin_role_change_events
FOR EACH ROW EXECUTE FUNCTION mirror_admin_role_change_to_audit();

COMMENT ON TABLE audit_events IS
  'Append-only minimized admin/security audit ledger. Retention and later anonymization are policy workflows, never ordinary edits or deletes.';
COMMENT ON COLUMN audit_events.changes IS
  'Allowlisted symbolic before/after values only; never copied contact, chat, document, secret, URL or arbitrary free-text payloads.';
COMMENT ON COLUMN audit_events.actor_user_id IS
  'Stable actor reference retained subject to D27 policy; account closure must not silently delete audit provenance.';
