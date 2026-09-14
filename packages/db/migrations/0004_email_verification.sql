ALTER TABLE auth_credentials
  ADD COLUMN email_verified_at timestamptz;

ALTER TABLE auth_credentials
  ADD CONSTRAINT auth_credentials_email_verified_after_creation
  CHECK (
    email_verified_at IS NULL
    OR email_verified_at >= created_at
  );

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_digest character(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  CONSTRAINT email_verification_tokens_digest_unique UNIQUE (token_digest),
  CONSTRAINT email_verification_tokens_digest_is_sha256
    CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_verification_tokens_timestamps_ordered
    CHECK (
      expires_at > created_at
      AND (consumed_at IS NULL OR consumed_at >= created_at)
      AND (invalidated_at IS NULL OR invalidated_at >= created_at)
    ),
  CONSTRAINT email_verification_tokens_one_terminal_state
    CHECK (num_nonnulls(consumed_at, invalidated_at) <= 1)
);

CREATE UNIQUE INDEX email_verification_tokens_live_user_idx
  ON email_verification_tokens (user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX email_verification_tokens_expiry_idx
  ON email_verification_tokens (expires_at);
