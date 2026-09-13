CREATE TYPE user_account_state AS ENUM (
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED'
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_state user_account_state NOT NULL DEFAULT 'ACTIVE',
  account_state_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_state_change_not_before_creation
    CHECK (account_state_changed_at >= created_at),
  CONSTRAINT users_update_not_before_state_change
    CHECK (updated_at >= account_state_changed_at)
);
