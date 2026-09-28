-- D01/D30/R4-033: provider-neutral invitation-only registration intake.
-- The migration starts PAUSED and contains no delivery-provider assumption.

CREATE TYPE alpha_registration_intake_state AS ENUM ('OPEN', 'PAUSED');

CREATE TABLE alpha_registration_intake_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL UNIQUE,
  revision bigint NOT NULL UNIQUE CHECK (revision > 0),
  state alpha_registration_intake_state NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    char_length(btrim(reason)) BETWEEN 8 AND 500
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO alpha_registration_intake_events (
  event_id,
  command_id,
  revision,
  state,
  actor_user_id,
  reason,
  payload_fingerprint
) VALUES (
  '00000000-0000-4000-8000-000000000115',
  '00000000-0000-4000-8000-000000000116',
  1,
  'PAUSED',
  NULL,
  'Initial fail-closed registration intake state.',
  repeat('0', 64)
);

CREATE VIEW current_alpha_registration_intake
WITH (security_invoker = true)
AS
SELECT revision, state, actor_user_id, reason, recorded_at
FROM alpha_registration_intake_events
ORDER BY revision DESC
LIMIT 1;

CREATE TABLE alpha_registration_invitations (
  invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL UNIQUE,
  email_hmac_digest char(64) NOT NULL CHECK (
    email_hmac_digest ~ '^[a-f0-9]{64}$'
  ),
  cohort_code text NOT NULL CHECK (
    cohort_code ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'
  ),
  issued_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT alpha_registration_invitation_expiry CHECK (
    expires_at > issued_at
  )
);

CREATE INDEX alpha_registration_invitations_digest_idx
  ON alpha_registration_invitations (email_hmac_digest, expires_at DESC);

CREATE TABLE alpha_registration_invitation_revocations (
  invitation_id uuid PRIMARY KEY
    REFERENCES alpha_registration_invitations(invitation_id)
    ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    char_length(btrim(reason)) BETWEEN 8 AND 500
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  payload_fingerprint char(64) NOT NULL CHECK (
    payload_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE alpha_registration_invitation_claims (
  invitation_id uuid PRIMARY KEY
    REFERENCES alpha_registration_invitations(invitation_id)
    ON DELETE RESTRICT,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION reject_alpha_registration_intake_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Alpha registration intake history is append-only';
END;
$$;

CREATE TRIGGER alpha_registration_intake_events_append_only
BEFORE UPDATE OR DELETE ON alpha_registration_intake_events
FOR EACH ROW EXECUTE FUNCTION reject_alpha_registration_intake_mutation();

CREATE TRIGGER alpha_registration_invitations_append_only
BEFORE UPDATE OR DELETE ON alpha_registration_invitations
FOR EACH ROW EXECUTE FUNCTION reject_alpha_registration_intake_mutation();

CREATE TRIGGER alpha_registration_invitation_revocations_append_only
BEFORE UPDATE OR DELETE ON alpha_registration_invitation_revocations
FOR EACH ROW EXECUTE FUNCTION reject_alpha_registration_intake_mutation();

CREATE TRIGGER alpha_registration_invitation_claims_append_only
BEFORE UPDATE OR DELETE ON alpha_registration_invitation_claims
FOR EACH ROW EXECUTE FUNCTION reject_alpha_registration_intake_mutation();

COMMENT ON TABLE alpha_registration_intake_events IS
  'Append-only global OPEN/PAUSED account-intake history; PAUSED never affects existing accounts or Jobs.';
COMMENT ON TABLE alpha_registration_invitations IS
  'Provider-neutral one-time registration invitations keyed only by a server HMAC email digest.';
COMMENT ON TABLE alpha_registration_invitation_claims IS
  'Immutable invitation claim created atomically with the invited user credential.';

REVOKE ALL ON alpha_registration_intake_events FROM PUBLIC;
REVOKE ALL ON alpha_registration_invitations FROM PUBLIC;
REVOKE ALL ON alpha_registration_invitation_revocations FROM PUBLIC;
REVOKE ALL ON alpha_registration_invitation_claims FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reject_alpha_registration_intake_mutation()
  FROM PUBLIC;
