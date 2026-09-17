CREATE TYPE job_state AS ENUM ('CONFIRMED');

-- R4-002 foundation. The public acceptQuote command is deliberately not wired
-- until the immutable R4-003 snapshots and competitor closeout are atomic.
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  job_request_id uuid NOT NULL UNIQUE
    REFERENCES job_requests(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  primary_craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  winning_invitation_id uuid NOT NULL UNIQUE
    REFERENCES job_invitations(id) ON DELETE RESTRICT,
  winning_conversation_id uuid NOT NULL UNIQUE
    REFERENCES conversations(id) ON DELETE RESTRICT,
  accepted_quote_id uuid NOT NULL UNIQUE
    REFERENCES quotes(id) ON DELETE RESTRICT,
  accepted_quote_revision integer NOT NULL,
  accepted_request_content_revision integer NOT NULL,
  accepted_request_visible_version integer NOT NULL,
  acceptance_command_id uuid NOT NULL UNIQUE,
  acceptance_payload_fingerprint char(64) NOT NULL,
  accepted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initial_state job_state NOT NULL DEFAULT 'CONFIRMED',
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (accepted_quote_id, accepted_quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (job_request_id, accepted_request_content_revision)
    REFERENCES job_request_active_content_revisions(
      job_request_id, content_revision
    ) ON DELETE RESTRICT,
  CONSTRAINT jobs_positive_revisions CHECK (
    accepted_quote_revision > 0
    AND accepted_request_content_revision > 0
    AND accepted_request_visible_version > 0
  ),
  CONSTRAINT jobs_fingerprint_sha256 CHECK (
    acceptance_payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX jobs_customer_accepted_idx
  ON jobs (customer_profile_id, accepted_at DESC, id);
CREATE INDEX jobs_provider_accepted_idx
  ON jobs (primary_craftsman_profile_id, accepted_at DESC, id);

CREATE FUNCTION validate_job_acceptance_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  matched boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.job_request_id::text, 41007)
  );
  SELECT true INTO matched
  FROM job_requests request
  JOIN customer_profiles customer
    ON customer.id = request.customer_profile_id
  JOIN users actor
    ON actor.id = customer.owner_user_id
  JOIN job_invitations invitation
    ON invitation.id = NEW.winning_invitation_id
    AND invitation.job_request_id = request.id
    AND invitation.customer_profile_id = customer.id
  JOIN craftsman_profiles craftsman
    ON craftsman.id = invitation.craftsman_profile_id
  JOIN conversations conversation
    ON conversation.id = NEW.winning_conversation_id
    AND conversation.invitation_id = invitation.id
  JOIN quotes quote
    ON quote.id = NEW.accepted_quote_id
    AND quote.invitation_id = invitation.id
    AND quote.conversation_id = conversation.id
  JOIN quote_revision_identities quote_revision
    ON quote_revision.quote_id = quote.id
    AND quote_revision.revision = NEW.accepted_quote_revision
  JOIN job_request_active_content_revisions request_revision
    ON request_revision.job_request_id = request.id
    AND request_revision.content_revision =
      quote_revision.request_content_revision
    AND request_revision.visible_version =
      quote_revision.request_visible_version
  WHERE request.id = NEW.job_request_id
    AND customer.id = NEW.customer_profile_id
    AND craftsman.id = NEW.primary_craftsman_profile_id
    AND actor.id = NEW.accepted_by_user_id
    AND quote_revision.request_content_revision =
      NEW.accepted_request_content_revision
    AND quote_revision.request_visible_version =
      NEW.accepted_request_visible_version
  FOR UPDATE OF request, customer, actor, invitation, craftsman,
    conversation, quote;
  IF matched IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'exact owned Job acceptance identity required';
  END IF;
  NEW.accepted_at := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1
    FROM current_quote_acceptance_context context
    JOIN quotes quote ON quote.id = context.quote_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN current_job_invitations invitation_state
      ON invitation_state.id = invitation.id
    JOIN current_job_requests request
      ON request.id = invitation.job_request_id
    JOIN users customer_actor ON customer_actor.id = NEW.accepted_by_user_id
    JOIN auth_credentials customer_auth
      ON customer_auth.user_id = customer_actor.id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    JOIN users provider_actor ON provider_actor.id = craftsman.owner_user_id
    JOIN auth_credentials provider_auth
      ON provider_auth.user_id = provider_actor.id
    JOIN current_searchable_craftsman_profiles searchable
      ON searchable.craftsman_profile_id = craftsman.id
    WHERE context.quote_id = NEW.accepted_quote_id
      AND context.quote_revision = NEW.accepted_quote_revision
      AND context.state = 'SUBMITTED'
      AND context.lifecycle_acceptance_eligible
      AND context.request_content_revision =
        NEW.accepted_request_content_revision
      AND context.request_visible_version =
        NEW.accepted_request_visible_version
      AND invitation_state.state = 'ENGAGED'
      AND invitation.id = NEW.winning_invitation_id
      AND request.id = NEW.job_request_id
      AND request.expires_at > NEW.accepted_at
      AND (context.valid_until IS NULL
        OR context.valid_until > NEW.accepted_at)
      AND customer_actor.account_state = 'ACTIVE'
      AND customer_auth.email_verified_at IS NOT NULL
      AND customer_auth.phone_verified_at IS NOT NULL
      AND provider_actor.account_state = 'ACTIVE'
      AND provider_auth.email_verified_at IS NOT NULL
      AND provider_auth.phone_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'current eligible Quote and parties required';
  END IF;
  NEW.id := gen_random_uuid();
  NEW.initial_state := 'CONFIRMED';
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_acceptance_identity_guard
BEFORE INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION validate_job_acceptance_identity();

CREATE FUNCTION reject_job_acceptance_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accepted Job identity is immutable';
END;
$$;

CREATE TRIGGER jobs_immutable
BEFORE UPDATE OR DELETE ON jobs
FOR EACH ROW EXECUTE FUNCTION reject_job_acceptance_identity_mutation();

COMMENT ON TABLE jobs IS
  'One immutable primary Job identity per JobRequest. Creation remains unavailable to HTTP until accepted commercial snapshots, state closeout and outbox effects share one transaction.';
