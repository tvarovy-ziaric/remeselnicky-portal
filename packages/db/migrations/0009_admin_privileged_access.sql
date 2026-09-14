CREATE TYPE admin_role AS ENUM ('ADMIN', 'SUPER_ADMIN');
CREATE TYPE admin_mfa_factor_kind AS ENUM ('TOTP', 'WEBAUTHN');
CREATE TYPE admin_mfa_purpose AS ENUM ('PRIVILEGED_SESSION', 'ROLE_CHANGE');

CREATE TABLE admin_role_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role admin_role NOT NULL,
  granted_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  grant_source text NOT NULL,
  reason text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  CONSTRAINT admin_role_grants_source_valid CHECK (
    (grant_source = 'ADMIN_COMMAND' AND granted_by_user_id IS NOT NULL)
    OR (grant_source = 'BOOTSTRAP' AND granted_by_user_id IS NULL)
  ),
  CONSTRAINT admin_role_grants_reason_bounded CHECK (
    length(btrim(reason)) BETWEEN 8 AND 500
  ),
  CONSTRAINT admin_role_grants_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (
      revoked_at IS NOT NULL
      AND revoked_by_user_id IS NOT NULL
      AND revoked_at >= granted_at
    )
  )
);

CREATE UNIQUE INDEX admin_role_grants_active_role_idx
  ON admin_role_grants (user_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_role_grants_active_user_idx
  ON admin_role_grants (user_id, granted_at)
  WHERE revoked_at IS NULL;

CREATE TABLE admin_mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind admin_mfa_factor_kind NOT NULL,
  credential_reference text NOT NULL,
  display_label text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  CONSTRAINT admin_mfa_factors_reference_bounded CHECK (
    credential_reference ~ '^[A-Za-z][A-Za-z0-9.-]{1,31}:[A-Za-z0-9/][A-Za-z0-9._:/-]{0,223}$'
  ),
  CONSTRAINT admin_mfa_factors_label_bounded CHECK (
    display_label IS NULL OR length(display_label) BETWEEN 1 AND 100
  ),
  CONSTRAINT admin_mfa_factors_timestamps_ordered CHECK (
    activated_at >= created_at
    AND (revoked_at IS NULL OR revoked_at >= activated_at)
  )
);

CREATE UNIQUE INDEX admin_mfa_factors_active_reference_idx
  ON admin_mfa_factors (credential_reference)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_mfa_factors_active_user_idx
  ON admin_mfa_factors (user_id, activated_at)
  WHERE revoked_at IS NULL;

CREATE TABLE admin_mfa_challenges (
  challenge_digest character(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  factor_id uuid NOT NULL REFERENCES admin_mfa_factors(id) ON DELETE RESTRICT,
  purpose admin_mfa_purpose NOT NULL,
  provider_state_reference text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT admin_mfa_challenges_digest_is_sha256 CHECK (
    challenge_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT admin_mfa_challenges_provider_state_bounded CHECK (
    provider_state_reference IS NULL
    OR provider_state_reference ~ '^[A-Za-z][A-Za-z0-9.-]{1,31}:[A-Za-z0-9/][A-Za-z0-9._:/-]{0,223}$'
  ),
  CONSTRAINT admin_mfa_challenges_timestamps_ordered CHECK (
    expires_at > created_at
    AND (claimed_at IS NULL OR claimed_at >= created_at)
    AND (verified_at IS NULL OR (claimed_at IS NOT NULL AND verified_at >= claimed_at))
  )
);

CREATE INDEX admin_mfa_challenges_expiry_idx
  ON admin_mfa_challenges (expires_at);

CREATE TABLE admin_privileged_sessions (
  session_id_hash character(64) PRIMARY KEY
    REFERENCES auth_sessions(session_id_hash) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mfa_factor_id uuid NOT NULL REFERENCES admin_mfa_factors(id) ON DELETE RESTRICT,
  mfa_authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT admin_privileged_sessions_digest_is_sha256 CHECK (
    session_id_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT admin_privileged_sessions_timestamps_ordered CHECK (
    mfa_authenticated_at <= created_at
    AND expires_at > created_at
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  )
);

CREATE INDEX admin_privileged_sessions_active_user_idx
  ON admin_privileged_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE admin_role_change_events (
  event_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  role admin_role NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT admin_role_change_events_action_valid CHECK (
    action IN ('ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED')
  ),
  CONSTRAINT admin_role_change_events_no_self_change CHECK (
    actor_user_id <> target_user_id
  ),
  CONSTRAINT admin_role_change_events_reason_bounded CHECK (
    length(btrim(reason)) BETWEEN 8 AND 500
  )
);

CREATE OR REPLACE FUNCTION prevent_admin_role_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin role change events are append-only';
END;
$$;

CREATE TRIGGER admin_role_change_events_append_only
BEFORE UPDATE OR DELETE ON admin_role_change_events
FOR EACH ROW EXECUTE FUNCTION prevent_admin_role_event_mutation();
