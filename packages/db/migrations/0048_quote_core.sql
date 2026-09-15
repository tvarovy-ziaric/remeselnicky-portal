CREATE TYPE quote_authoring_mode AS ENUM (
  'PLATFORM_STRUCTURED', 'EXTERNAL_PDF'
);
CREATE TYPE quote_revision_state AS ENUM (
  'DRAFT', 'SUBMITTED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN',
  'EXPIRED', 'ACCEPTED', 'NOT_SELECTED'
);
CREATE TYPE quote_core_command_kind AS ENUM (
  'CREATE_DRAFT', 'CREATE_REVISION', 'SUBMIT', 'REJECT'
);

CREATE TABLE quote_core_commands (
  command_id uuid PRIMARY KEY,
  quote_id uuid NOT NULL,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_kind quote_core_command_kind NOT NULL,
  quote_revision integer NOT NULL,
  authoring_mode quote_authoring_mode,
  request_content_revision integer,
  request_visible_version integer,
  expected_draft_state_revision integer,
  expected_submitted_state_revision integer,
  resulting_state_revision integer NOT NULL,
  target_state quote_revision_state NOT NULL,
  created_quote_id uuid,
  created_revision_quote_id uuid,
  created_revision_number integer,
  prior_quote_revision integer,
  prior_resulting_state_revision integer,
  prior_target_state quote_revision_state,
  rejection_reason text,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT quote_core_commands_positive CHECK (
    quote_revision > 0
    AND (expected_draft_state_revision IS NULL
      OR expected_draft_state_revision > 0)
    AND (expected_submitted_state_revision IS NULL
      OR expected_submitted_state_revision > 0)
    AND resulting_state_revision > 0
    AND (created_revision_number IS NULL OR created_revision_number > 0)
    AND (prior_quote_revision IS NULL OR prior_quote_revision > 0)
    AND (prior_resulting_state_revision IS NULL
      OR prior_resulting_state_revision > 0)
  ),
  CONSTRAINT quote_core_commands_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT quote_core_commands_reason CHECK (
    rejection_reason IS NULL OR (
      char_length(rejection_reason) BETWEEN 1 AND 500
      AND octet_length(rejection_reason) <= 2000
      AND rejection_reason = btrim(rejection_reason)
      AND rejection_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    )
  ),
  CONSTRAINT quote_core_commands_shape CHECK (
    (command_kind IN ('CREATE_DRAFT', 'CREATE_REVISION')
      AND authoring_mode IS NOT NULL
      AND request_content_revision IS NOT NULL
      AND request_visible_version IS NOT NULL
      AND expected_draft_state_revision IS NULL
      AND (command_kind = 'CREATE_DRAFT'
        OR expected_submitted_state_revision IS NOT NULL)
      AND resulting_state_revision = 1
      AND target_state = 'DRAFT' AND rejection_reason IS NULL
      AND created_revision_quote_id = quote_id
      AND created_revision_number = quote_revision
      AND ((command_kind = 'CREATE_DRAFT' AND created_quote_id = quote_id)
        OR (command_kind = 'CREATE_REVISION' AND created_quote_id IS NULL))
      AND prior_quote_revision IS NULL
      AND prior_resulting_state_revision IS NULL
      AND prior_target_state IS NULL)
    OR (command_kind = 'SUBMIT' AND authoring_mode IS NULL
      AND request_content_revision IS NULL
      AND request_visible_version IS NULL
      AND expected_draft_state_revision IS NOT NULL
      AND resulting_state_revision = expected_draft_state_revision + 1
      AND target_state = 'SUBMITTED' AND rejection_reason IS NULL
      AND created_quote_id IS NULL AND created_revision_quote_id IS NULL
      AND created_revision_number IS NULL
      AND ((expected_submitted_state_revision IS NULL
          AND prior_quote_revision IS NULL
          AND prior_resulting_state_revision IS NULL
          AND prior_target_state IS NULL)
        OR (expected_submitted_state_revision IS NOT NULL
          AND prior_quote_revision IS NOT NULL
          AND prior_resulting_state_revision =
            expected_submitted_state_revision + 1
          AND prior_target_state = 'SUPERSEDED')))
    OR (command_kind = 'REJECT' AND authoring_mode IS NULL
      AND request_content_revision IS NULL
      AND request_visible_version IS NULL
      AND expected_draft_state_revision IS NULL
      AND expected_submitted_state_revision IS NOT NULL
      AND resulting_state_revision = expected_submitted_state_revision + 1
      AND target_state = 'REJECTED'
      AND created_quote_id IS NULL AND created_revision_quote_id IS NULL
      AND created_revision_number IS NULL AND prior_quote_revision IS NULL
      AND prior_resulting_state_revision IS NULL
      AND prior_target_state IS NULL)
  )
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL UNIQUE
    REFERENCES job_invitations(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL UNIQUE
    REFERENCES conversations(id) ON DELETE RESTRICT,
  create_command_id uuid NOT NULL UNIQUE
    REFERENCES quote_core_commands(command_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL
);

ALTER TABLE quotes ADD CONSTRAINT quotes_id_create_command_unique
  UNIQUE (id, create_command_id);

ALTER TABLE quote_core_commands ADD CONSTRAINT quote_core_commands_quote_fk
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE quote_revision_identities (
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  create_command_id uuid NOT NULL UNIQUE
    REFERENCES quote_core_commands(command_id) ON DELETE RESTRICT,
  authoring_mode quote_authoring_mode NOT NULL,
  request_content_revision integer NOT NULL,
  request_visible_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, revision),
  CONSTRAINT quote_revision_identities_positive CHECK (revision > 0)
);

ALTER TABLE quote_revision_identities
  ADD CONSTRAINT quote_revision_identity_create_command_unique
  UNIQUE (quote_id, revision, create_command_id);

CREATE TABLE quote_revision_state_events (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  state_revision integer NOT NULL,
  command_id uuid NOT NULL
    REFERENCES quote_core_commands(command_id) ON DELETE RESTRICT,
  state quote_revision_state NOT NULL,
  rejection_reason text,
  changed_at timestamptz NOT NULL,
  submitted_at timestamptz,
  PRIMARY KEY (quote_id, quote_revision, state_revision),
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT quote_revision_state_events_positive CHECK (state_revision > 0),
  CONSTRAINT quote_revision_state_events_shape CHECK (
    (state = 'DRAFT' AND state_revision = 1 AND submitted_at IS NULL
      AND rejection_reason IS NULL)
    OR (state = 'SUBMITTED' AND submitted_at IS NOT NULL
      AND rejection_reason IS NULL)
    OR (state = 'REJECTED' AND submitted_at IS NOT NULL)
    OR (state IN ('SUPERSEDED', 'WITHDRAWN', 'EXPIRED', 'ACCEPTED',
      'NOT_SELECTED') AND submitted_at IS NOT NULL
      AND rejection_reason IS NULL)
  ),
  CONSTRAINT quote_revision_state_event_command_unique UNIQUE (
    command_id, quote_id, quote_revision, state_revision, state
  )
);

ALTER TABLE quote_core_commands
  ADD CONSTRAINT quote_command_created_quote_effect_fk
  FOREIGN KEY (created_quote_id, command_id)
  REFERENCES quotes(id, create_command_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE quote_core_commands
  ADD CONSTRAINT quote_command_created_revision_effect_fk
  FOREIGN KEY (
    created_revision_quote_id, created_revision_number, command_id
  ) REFERENCES quote_revision_identities(
    quote_id, revision, create_command_id
  ) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE quote_core_commands
  ADD CONSTRAINT quote_command_primary_state_effect_fk
  FOREIGN KEY (
    command_id, quote_id, quote_revision, resulting_state_revision,
    target_state
  ) REFERENCES quote_revision_state_events(
    command_id, quote_id, quote_revision, state_revision, state
  ) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE quote_core_commands
  ADD CONSTRAINT quote_command_prior_state_effect_fk
  FOREIGN KEY (
    command_id, quote_id, prior_quote_revision,
    prior_resulting_state_revision, prior_target_state
  ) REFERENCES quote_revision_state_events(
    command_id, quote_id, quote_revision, state_revision, state
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE quote_revision_heads (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  state_revision integer NOT NULL,
  state quote_revision_state NOT NULL,
  PRIMARY KEY (quote_id, quote_revision),
  FOREIGN KEY (quote_id, quote_revision, state_revision)
    REFERENCES quote_revision_state_events(
      quote_id, quote_revision, state_revision
    ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX quote_one_provider_draft_idx
  ON quote_revision_heads (quote_id) WHERE state = 'DRAFT';
CREATE UNIQUE INDEX quote_one_customer_submitted_idx
  ON quote_revision_heads (quote_id) WHERE state = 'SUBMITTED';

CREATE VIEW current_quote_revision_states AS
SELECT
  identity.quote_id, identity.revision, identity.authoring_mode,
  identity.request_content_revision, identity.request_visible_version,
  identity.created_at, event.state_revision, event.state,
  event.rejection_reason, event.changed_at, event.submitted_at
FROM quote_revision_identities identity
JOIN quote_revision_heads head
  ON head.quote_id = identity.quote_id
  AND head.quote_revision = identity.revision
JOIN quote_revision_state_events event
  ON event.quote_id = head.quote_id
  AND event.quote_revision = head.quote_revision
  AND event.state_revision = head.state_revision;

CREATE VIEW current_quote_drafts AS
SELECT * FROM current_quote_revision_states WHERE state = 'DRAFT';

CREATE VIEW current_submitted_quotes AS
SELECT * FROM current_quote_revision_states WHERE state = 'SUBMITTED';

-- R3-016/R3-017 replace this hook with mode-specific validated content checks.
-- Core submission therefore fails closed and accepts no client readiness flag.
CREATE FUNCTION quote_revision_authoring_is_eligible(
  uuid, integer, quote_authoring_mode
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$ SELECT false; $$;

CREATE FUNCTION quote_active_participant_context(
  target_conversation_id uuid,
  target_actor_user_id uuid,
  required_role text,
  require_writable boolean
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM current_conversations conversation
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    JOIN users actor ON actor.id = target_actor_user_id
      AND actor.account_state = 'ACTIVE'
    WHERE conversation.id = target_conversation_id
      AND (NOT require_writable OR (
        conversation.access_state = 'WRITABLE'
        AND conversation.invitation_state = 'ENGAGED'))
      AND ((required_role = 'CUSTOMER'
          AND customer.owner_user_id = actor.id)
        OR (required_role = 'CRAFTSMAN'
          AND craftsman.owner_user_id = actor.id))
  );
$$;

CREATE FUNCTION validate_quote_core_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_conversation current_conversations%ROWTYPE;
  source_quote quotes%ROWTYPE;
  current_draft current_quote_revision_states%ROWTYPE;
  current_submitted current_quote_revision_states%ROWTYPE;
  next_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.command_id::text, 48001));
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned quote context required'; END IF;

  SELECT * INTO source_conversation FROM current_conversations conversation
  WHERE conversation.id = NEW.conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned quote context required'; END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_conversation.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = NEW.conversation_id FOR UPDATE;

  IF NEW.command_kind = 'CREATE_DRAFT' THEN
    IF NOT quote_active_participant_context(
      NEW.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', false
    ) THEN RAISE EXCEPTION 'owned quote context required';
    END IF;
    IF NOT quote_active_participant_context(
      NEW.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', true
    ) THEN RAISE EXCEPTION 'writable quote conversation required';
    END IF;
    IF EXISTS (SELECT 1 FROM quotes quote
      WHERE quote.conversation_id = NEW.conversation_id) THEN
      RAISE EXCEPTION 'quote lineage already exists for conversation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM job_request_active_content_revisions provenance
      WHERE provenance.job_request_id = source_conversation.job_request_id
        AND provenance.content_revision = NEW.request_content_revision
        AND provenance.visible_version = NEW.request_visible_version
    ) THEN RAISE EXCEPTION 'exact quote request provenance required'; END IF;
    NEW.quote_id := gen_random_uuid();
    NEW.quote_revision := 1;
    NEW.expected_submitted_state_revision := NULL;
    NEW.resulting_state_revision := 1;
    NEW.created_quote_id := NEW.quote_id;
    NEW.created_revision_quote_id := NEW.quote_id;
    NEW.created_revision_number := 1;
    NEW.prior_quote_revision := NULL;
    NEW.prior_resulting_state_revision := NULL;
    NEW.prior_target_state := NULL;
  ELSE
    SELECT * INTO source_quote FROM quotes quote
    WHERE quote.id = NEW.quote_id AND quote.conversation_id = NEW.conversation_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'owned quote lineage required'; END IF;
    SELECT * INTO current_draft FROM current_quote_drafts draft
    WHERE draft.quote_id = source_quote.id;
    SELECT * INTO current_submitted FROM current_submitted_quotes submitted
    WHERE submitted.quote_id = source_quote.id;

    IF NEW.command_kind IN ('CREATE_REVISION', 'SUBMIT') THEN
      IF NOT quote_active_participant_context(
        NEW.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', false
      ) THEN RAISE EXCEPTION 'owned quote context required';
      END IF;
      IF NOT quote_active_participant_context(
        NEW.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', true
      ) THEN RAISE EXCEPTION 'writable quote conversation required';
      END IF;
    ELSE
      IF NOT quote_active_participant_context(
        NEW.conversation_id, NEW.actor_user_id, 'CUSTOMER', false
      ) THEN RAISE EXCEPTION 'owned quote context required';
      END IF;
      IF NOT quote_active_participant_context(
        NEW.conversation_id, NEW.actor_user_id, 'CUSTOMER', true
      ) THEN RAISE EXCEPTION 'writable quote conversation required';
      END IF;
    END IF;

    IF NEW.command_kind = 'CREATE_REVISION' THEN
      IF current_draft.quote_id IS NOT NULL
          OR current_submitted.quote_id IS NULL
          OR current_submitted.state_revision <>
            NEW.expected_submitted_state_revision THEN
        RAISE EXCEPTION 'quote revision creation transition is invalid or stale';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM job_request_active_content_revisions provenance
        WHERE provenance.job_request_id = source_conversation.job_request_id
          AND provenance.content_revision = NEW.request_content_revision
          AND provenance.visible_version = NEW.request_visible_version
      ) THEN RAISE EXCEPTION 'exact quote request provenance required'; END IF;
      SELECT coalesce(max(identity.revision), 0) + 1 INTO next_revision
      FROM quote_revision_identities identity
      WHERE identity.quote_id = source_quote.id;
      NEW.quote_revision := next_revision;
      NEW.resulting_state_revision := 1;
      NEW.created_quote_id := NULL;
      NEW.created_revision_quote_id := NEW.quote_id;
      NEW.created_revision_number := next_revision;
      NEW.prior_quote_revision := NULL;
      NEW.prior_resulting_state_revision := NULL;
      NEW.prior_target_state := NULL;
    ELSIF NEW.command_kind = 'SUBMIT' THEN
      IF current_draft.quote_id IS NULL
          OR current_draft.revision <> NEW.quote_revision
          OR current_draft.state_revision <> NEW.expected_draft_state_revision
          OR (current_submitted.quote_id IS NULL
            AND NEW.expected_submitted_state_revision IS NOT NULL)
          OR (current_submitted.quote_id IS NOT NULL
            AND current_submitted.state_revision IS DISTINCT FROM
              NEW.expected_submitted_state_revision) THEN
        RAISE EXCEPTION 'quote submission transition is invalid or stale';
      END IF;
      IF NOT quote_revision_authoring_is_eligible(
        source_quote.id, current_draft.revision, current_draft.authoring_mode
      ) THEN RAISE EXCEPTION 'quote authoring is not ready for submission'; END IF;
      NEW.resulting_state_revision := current_draft.state_revision + 1;
      NEW.created_quote_id := NULL;
      NEW.created_revision_quote_id := NULL;
      NEW.created_revision_number := NULL;
      IF current_submitted.quote_id IS NULL THEN
        NEW.prior_quote_revision := NULL;
        NEW.prior_resulting_state_revision := NULL;
        NEW.prior_target_state := NULL;
      ELSE
        NEW.prior_quote_revision := current_submitted.revision;
        NEW.prior_resulting_state_revision :=
          current_submitted.state_revision + 1;
        NEW.prior_target_state := 'SUPERSEDED';
      END IF;
    ELSIF NEW.command_kind = 'REJECT' THEN
      IF current_submitted.quote_id IS NULL
          OR current_submitted.revision <> NEW.quote_revision
          OR current_submitted.state_revision <>
            NEW.expected_submitted_state_revision THEN
        RAISE EXCEPTION 'quote rejection transition is invalid or stale';
      END IF;
      NEW.resulting_state_revision := current_submitted.state_revision + 1;
      NEW.created_quote_id := NULL;
      NEW.created_revision_quote_id := NULL;
      NEW.created_revision_number := NULL;
      NEW.prior_quote_revision := NULL;
      NEW.prior_resulting_state_revision := NULL;
      NEW.prior_target_state := NULL;
    END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_core_commands_guard
BEFORE INSERT ON quote_core_commands
FOR EACH ROW EXECUTE FUNCTION validate_quote_core_command();

CREATE FUNCTION validate_quote_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_core_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM quote_core_commands command
  WHERE command.command_id = NEW.create_command_id FOR UPDATE;
  IF NOT FOUND OR source.command_kind <> 'CREATE_DRAFT'
      OR source.quote_id <> NEW.id
      OR source.conversation_id <> NEW.conversation_id THEN
    RAISE EXCEPTION 'quote identity requires exact create command';
  END IF;
  SELECT conversation.invitation_id INTO NEW.invitation_id
  FROM conversations conversation WHERE conversation.id = NEW.conversation_id;
  NEW.created_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quotes_identity_guard BEFORE INSERT ON quotes
FOR EACH ROW EXECUTE FUNCTION validate_quote_identity();

CREATE FUNCTION validate_quote_revision_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_core_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM quote_core_commands command
  WHERE command.command_id = NEW.create_command_id FOR UPDATE;
  IF NOT FOUND OR source.command_kind NOT IN ('CREATE_DRAFT', 'CREATE_REVISION')
      OR source.quote_id <> NEW.quote_id
      OR source.quote_revision <> NEW.revision
      OR source.authoring_mode <> NEW.authoring_mode
      OR source.request_content_revision <> NEW.request_content_revision
      OR source.request_visible_version <> NEW.request_visible_version THEN
    RAISE EXCEPTION 'quote revision identity requires exact create command';
  END IF;
  NEW.created_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_revision_identities_guard
BEFORE INSERT ON quote_revision_identities
FOR EACH ROW EXECUTE FUNCTION validate_quote_revision_identity();

CREATE FUNCTION validate_quote_revision_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_core_commands%ROWTYPE;
DECLARE prior current_quote_revision_states%ROWTYPE;
BEGIN
  SELECT * INTO source FROM quote_core_commands command
  WHERE command.command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.quote_id <> NEW.quote_id THEN
    RAISE EXCEPTION 'quote state event requires exact command';
  END IF;
  SELECT * INTO prior FROM current_quote_revision_states current
  WHERE current.quote_id = NEW.quote_id
    AND current.revision = NEW.quote_revision;

  IF source.command_kind IN ('CREATE_DRAFT', 'CREATE_REVISION') THEN
    IF prior.quote_id IS NOT NULL OR NEW.quote_revision <> source.quote_revision
        OR NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'invalid quote draft state event';
    END IF;
    NEW.state_revision := 1;
    NEW.submitted_at := NULL;
    NEW.rejection_reason := NULL;
  ELSIF source.command_kind = 'SUBMIT' THEN
    IF NEW.quote_revision = source.quote_revision THEN
      IF prior.state <> 'DRAFT'
          OR prior.state_revision <> source.expected_draft_state_revision
          OR NEW.state <> 'SUBMITTED' THEN
        RAISE EXCEPTION 'invalid quote submission state event';
      END IF;
      NEW.state_revision := prior.state_revision + 1;
      NEW.submitted_at := clock_timestamp();
    ELSE
      IF prior.state <> 'SUBMITTED'
          OR prior.state_revision <> source.expected_submitted_state_revision
          OR NEW.state <> 'SUPERSEDED' THEN
        RAISE EXCEPTION 'invalid quote supersession state event';
      END IF;
      NEW.state_revision := prior.state_revision + 1;
      NEW.submitted_at := prior.submitted_at;
    END IF;
    NEW.rejection_reason := NULL;
  ELSIF source.command_kind = 'REJECT' THEN
    IF NEW.quote_revision <> source.quote_revision
        OR prior.state <> 'SUBMITTED'
        OR prior.state_revision <> source.expected_submitted_state_revision
        OR NEW.state <> 'REJECTED' THEN
      RAISE EXCEPTION 'invalid quote rejection state event';
    END IF;
    NEW.state_revision := prior.state_revision + 1;
    NEW.submitted_at := prior.submitted_at;
    NEW.rejection_reason := source.rejection_reason;
  ELSE
    RAISE EXCEPTION 'unsupported quote core state event';
  END IF;
  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_revision_state_events_guard
BEFORE INSERT ON quote_revision_state_events
FOR EACH ROW EXECUTE FUNCTION validate_quote_revision_state_event();

CREATE FUNCTION advance_quote_revision_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO quote_revision_heads (
    quote_id, quote_revision, state_revision, state
  ) VALUES (
    NEW.quote_id, NEW.quote_revision, NEW.state_revision, NEW.state
  )
  ON CONFLICT (quote_id, quote_revision) DO UPDATE SET
    state_revision = EXCLUDED.state_revision,
    state = EXCLUDED.state;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_revision_state_event_advances_head
AFTER INSERT ON quote_revision_state_events
FOR EACH ROW EXECUTE FUNCTION advance_quote_revision_head();

CREATE FUNCTION reject_direct_quote_revision_head_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'quote revision heads are event-derived';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_revision_heads_event_derived
BEFORE INSERT OR UPDATE OR DELETE ON quote_revision_heads
FOR EACH ROW EXECUTE FUNCTION reject_direct_quote_revision_head_mutation();

CREATE FUNCTION reject_quote_core_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'quote core history is append-only'; END;
$$;

CREATE TRIGGER quote_core_commands_append_only
BEFORE UPDATE OR DELETE ON quote_core_commands
FOR EACH ROW EXECUTE FUNCTION reject_quote_core_mutation();
CREATE TRIGGER quotes_append_only
BEFORE UPDATE OR DELETE ON quotes
FOR EACH ROW EXECUTE FUNCTION reject_quote_core_mutation();
CREATE TRIGGER quote_revision_identities_append_only
BEFORE UPDATE OR DELETE ON quote_revision_identities
FOR EACH ROW EXECUTE FUNCTION reject_quote_core_mutation();
CREATE TRIGGER quote_revision_state_events_append_only
BEFORE UPDATE OR DELETE ON quote_revision_state_events
FOR EACH ROW EXECUTE FUNCTION reject_quote_core_mutation();

CREATE INDEX quote_commands_lineage_history_idx
  ON quote_core_commands (quote_id, created_at, command_id);
CREATE INDEX quote_revision_state_history_idx
  ON quote_revision_state_events (
    quote_id, quote_revision, state_revision DESC
  );

COMMENT ON TABLE quotes IS
  'One immutable Quote lineage per concrete invitation/conversation.';
COMMENT ON TABLE quote_revision_identities IS
  'Immutable authoring-mode and exact JobRequest-version provenance; content is owned by R3-016/R3-017.';
COMMENT ON FUNCTION quote_revision_authoring_is_eligible(uuid, integer, quote_authoring_mode) IS
  'Fail-closed R3-015 seam replaced by mode-specific validated authoring migrations.';
