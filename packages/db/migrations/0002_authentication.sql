CREATE TABLE auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  normalized_email text NOT NULL,
  password_hash text NOT NULL,
  adult_attested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  password_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT auth_credentials_normalized_email_unique UNIQUE (normalized_email),
  CONSTRAINT auth_credentials_normalized_email_canonical
    CHECK (
      normalized_email = lower(btrim(normalized_email))
      AND length(normalized_email) BETWEEN 3 AND 320
    ),
  CONSTRAINT auth_credentials_password_hash_bounded
    CHECK (length(password_hash) BETWEEN 20 AND 1024),
  CONSTRAINT auth_credentials_timestamps_ordered
    CHECK (
      adult_attested_at >= created_at
      AND password_changed_at >= created_at
      AND updated_at >= password_changed_at
    )
);

CREATE TABLE auth_sessions (
  session_id_hash character(64) PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_id_is_sha256_digest
    CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_sessions_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT auth_sessions_timestamps_ordered
    CHECK (
      expires_at > created_at
      AND last_seen_at >= created_at
      AND (revoked_at IS NULL OR revoked_at >= created_at)
    )
);

CREATE INDEX auth_sessions_live_user_idx
  ON auth_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_expiry_idx
  ON auth_sessions (expires_at);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_digest character(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  CONSTRAINT password_reset_tokens_digest_unique UNIQUE (token_digest),
  CONSTRAINT password_reset_tokens_digest_is_sha256
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_timestamps_ordered
    CHECK (
      expires_at > created_at
      AND (consumed_at IS NULL OR consumed_at >= created_at)
      AND (invalidated_at IS NULL OR invalidated_at >= created_at)
    ),
  CONSTRAINT password_reset_tokens_one_terminal_state
    CHECK (num_nonnulls(consumed_at, invalidated_at) <= 1)
);

CREATE UNIQUE INDEX password_reset_tokens_live_user_idx
  ON password_reset_tokens (user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at);

CREATE TABLE auth_rate_limit_buckets (
  scope text NOT NULL,
  key_digest character(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, key_digest),
  CONSTRAINT auth_rate_limit_scope_bounded
    CHECK (length(scope) BETWEEN 1 AND 80),
  CONSTRAINT auth_rate_limit_key_is_sha256_digest
    CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_rate_limit_window_valid
    CHECK (expires_at > window_started_at),
  CONSTRAINT auth_rate_limit_attempt_count_positive
    CHECK (attempt_count > 0)
);

CREATE INDEX auth_rate_limit_buckets_expiry_idx
  ON auth_rate_limit_buckets (expires_at);
