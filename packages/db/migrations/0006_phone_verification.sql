ALTER TABLE auth_credentials
  ADD COLUMN normalized_phone text,
  ADD COLUMN phone_verified_at timestamptz;

ALTER TABLE auth_credentials
  ADD CONSTRAINT auth_credentials_phone_verification_complete
  CHECK (
    (normalized_phone IS NULL AND phone_verified_at IS NULL)
    OR (
      normalized_phone ~ '^\+[1-9][0-9]{7,14}$'
      AND phone_verified_at IS NOT NULL
      AND phone_verified_at >= created_at
    )
  );

CREATE TABLE phone_verification_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  normalized_phone text NOT NULL,
  otp_digest character(64) NOT NULL,
  otp_salt character(32) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  CONSTRAINT phone_verification_challenges_phone_is_e164
    CHECK (normalized_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT phone_verification_challenges_digest_is_hmac_sha256
    CHECK (otp_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT phone_verification_challenges_salt_is_128_bit_hex
    CHECK (otp_salt ~ '^[0-9a-f]{32}$'),
  CONSTRAINT phone_verification_challenges_attempts_bounded
    CHECK (
      max_attempts BETWEEN 1 AND 20
      AND attempt_count BETWEEN 0 AND max_attempts
    ),
  CONSTRAINT phone_verification_challenges_timestamps_ordered
    CHECK (
      expires_at > created_at
      AND (consumed_at IS NULL OR consumed_at >= created_at)
      AND (invalidated_at IS NULL OR invalidated_at >= created_at)
    ),
  CONSTRAINT phone_verification_challenges_one_terminal_state
    CHECK (num_nonnulls(consumed_at, invalidated_at) <= 1)
);

CREATE UNIQUE INDEX phone_verification_challenges_live_user_idx
  ON phone_verification_challenges (user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE UNIQUE INDEX phone_verification_challenges_salt_idx
  ON phone_verification_challenges (otp_salt);

CREATE INDEX phone_verification_challenges_expiry_idx
  ON phone_verification_challenges (expires_at);
