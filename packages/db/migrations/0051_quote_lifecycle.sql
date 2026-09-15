CREATE TYPE quote_lifecycle_command_kind AS ENUM ('WITHDRAW', 'EXPIRE');
CREATE TYPE quote_lifecycle_actor_kind AS ENUM ('PROVIDER', 'SYSTEM');

CREATE TABLE quote_lifecycle_commands (
  command_id uuid PRIMARY KEY,
  command_kind quote_lifecycle_command_kind NOT NULL,
  actor_kind quote_lifecycle_actor_kind NOT NULL,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  quote_revision integer NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_system_reference text,
  expected_state_revision integer NOT NULL,
  resulting_state_revision integer NOT NULL,
  target_state quote_revision_state NOT NULL,
  valid_until_snapshot timestamptz,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision) ON DELETE RESTRICT,
  CONSTRAINT quote_lifecycle_command_revision_shape CHECK (
    quote_revision > 0 AND expected_state_revision > 0
    AND resulting_state_revision = expected_state_revision + 1
  ),
  CONSTRAINT quote_lifecycle_command_kind_shape CHECK (
    (command_kind = 'WITHDRAW' AND actor_kind = 'PROVIDER'
      AND actor_user_id IS NOT NULL AND actor_system_reference IS NULL
      AND target_state = 'WITHDRAWN' AND valid_until_snapshot IS NULL)
    OR (command_kind = 'EXPIRE' AND actor_kind = 'SYSTEM'
      AND actor_user_id IS NULL
      AND actor_system_reference = 'quote-lifecycle:deadline-sweeper'
      AND target_state = 'EXPIRED' AND valid_until_snapshot IS NOT NULL)
  ),
  CONSTRAINT quote_lifecycle_command_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

ALTER TABLE quote_revision_state_events
  ALTER COLUMN command_id DROP NOT NULL,
  ADD COLUMN lifecycle_command_id uuid
    REFERENCES quote_lifecycle_commands(command_id) ON DELETE RESTRICT,
  ADD CONSTRAINT quote_state_event_one_command_source CHECK (
    (command_id IS NULL) <> (lifecycle_command_id IS NULL)
  ),
  ADD CONSTRAINT quote_lifecycle_state_event_unique UNIQUE (
    lifecycle_command_id, quote_id, quote_revision, state_revision, state
  ),
  ADD CONSTRAINT quote_revision_state_source_unique UNIQUE (
    quote_id, quote_revision, state_revision, state
  );

ALTER TABLE quote_core_commands
  ADD COLUMN source_quote_revision integer,
  ADD COLUMN source_state quote_revision_state,
  ADD COLUMN source_state_revision integer,
  ADD CONSTRAINT quote_core_revision_source_shape CHECK (
    (command_kind = 'CREATE_REVISION' AND source_quote_revision IS NOT NULL
      AND source_state IN ('SUBMITTED', 'EXPIRED', 'WITHDRAWN')
      AND source_state_revision IS NOT NULL)
    OR (command_kind <> 'CREATE_REVISION' AND source_quote_revision IS NULL
      AND source_state IS NULL AND source_state_revision IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT quote_core_revision_source_fk FOREIGN KEY (
    quote_id, source_quote_revision, source_state_revision, source_state
  ) REFERENCES quote_revision_state_events (
    quote_id, quote_revision, state_revision, state
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE quote_lifecycle_commands
  ADD CONSTRAINT quote_lifecycle_command_effect_fk FOREIGN KEY (
    command_id, quote_id, quote_revision, resulting_state_revision, target_state
  ) REFERENCES quote_revision_state_events (
    lifecycle_command_id, quote_id, quote_revision, state_revision, state
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION quote_revision_valid_until(
  target_quote_id uuid,
  target_quote_revision integer,
  target_authoring_mode quote_authoring_mode
)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT CASE target_authoring_mode
    WHEN 'PLATFORM_STRUCTURED' THEN (
      SELECT content.valid_until FROM current_quote_structured_content content
      WHERE content.quote_id = target_quote_id
        AND content.quote_revision = target_quote_revision
    )
    WHEN 'EXTERNAL_PDF' THEN (
      SELECT content.valid_until FROM current_quote_external_pdf_content content
      WHERE content.quote_id = target_quote_id
        AND content.quote_revision = target_quote_revision
        AND content.provider_confirmed_summary_matches_pdf
    )
  END;
$$;

CREATE FUNCTION validate_quote_lifecycle_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_quote quotes%ROWTYPE;
  source_revision quote_revision_identities%ROWTYPE;
  source_head quote_revision_heads%ROWTYPE;
  deadline timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.command_id::text, 51001));
  IF NEW.command_kind = 'WITHDRAW' THEN
    NEW.actor_kind := 'PROVIDER';
    NEW.actor_system_reference := NULL;
    PERFORM 1 FROM users actor
    WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'owned Quote lifecycle context required'; END IF;
  ELSIF NEW.command_kind = 'EXPIRE' THEN
    -- EXPIRE has no user-facing route. Authority metadata is DB-authored.
    NEW.actor_kind := 'SYSTEM';
    NEW.actor_user_id := NULL;
    NEW.actor_system_reference := 'quote-lifecycle:deadline-sweeper';
  END IF;

  SELECT * INTO source_quote FROM quotes quote WHERE quote.id = NEW.quote_id;
  IF source_quote.id IS NULL OR source_quote.conversation_id <> NEW.conversation_id THEN
    RAISE EXCEPTION 'owned Quote lifecycle context required';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = source_quote.conversation_id FOR UPDATE;
  PERFORM 1 FROM quotes quote WHERE quote.id = source_quote.id FOR UPDATE;

  SELECT * INTO source_revision FROM quote_revision_identities identity
  WHERE identity.quote_id = source_quote.id AND identity.revision = NEW.quote_revision;
  SELECT * INTO source_head FROM quote_revision_heads head
  WHERE head.quote_id = source_quote.id AND head.quote_revision = NEW.quote_revision
  FOR UPDATE;
  IF source_revision.quote_id IS NULL OR source_head.state <> 'SUBMITTED'
      OR source_head.state_revision <> NEW.expected_state_revision THEN
    RAISE EXCEPTION 'Quote lifecycle transition is invalid or stale';
  END IF;

  IF NEW.command_kind = 'WITHDRAW' THEN
    IF NOT quote_active_participant_context(
      source_quote.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', true
    ) THEN RAISE EXCEPTION 'owned Quote lifecycle context required'; END IF;
    NEW.target_state := 'WITHDRAWN';
    NEW.valid_until_snapshot := NULL;
  ELSIF NEW.command_kind = 'EXPIRE' THEN
    deadline := quote_revision_valid_until(
      source_quote.id, source_revision.revision, source_revision.authoring_mode
    );
    IF deadline IS NULL OR deadline > clock_timestamp() THEN
      RAISE EXCEPTION 'Quote is not due for expiry';
    END IF;
    NEW.target_state := 'EXPIRED';
    NEW.valid_until_snapshot := deadline;
  ELSE
    RAISE EXCEPTION 'unsupported Quote lifecycle command';
  END IF;
  NEW.resulting_state_revision := source_head.state_revision + 1;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_lifecycle_commands_guard
BEFORE INSERT ON quote_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION validate_quote_lifecycle_command();

-- Preserve the R3-015 command surface while allowing a fresh immutable draft
-- from the latest EXPIRED/WITHDRAWN source. Every CREATE_REVISION is pinned to
-- the current request version under the request-row lock.
CREATE OR REPLACE FUNCTION validate_quote_core_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_conversation current_conversations%ROWTYPE;
  source_quote quotes%ROWTYPE;
  current_draft current_quote_revision_states%ROWTYPE;
  current_submitted current_quote_revision_states%ROWTYPE;
  current_terminal current_quote_revision_states%ROWTYPE;
  current_request job_request_active_content_revisions%ROWTYPE;
  next_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.command_id::text, 48001));
  NEW.source_quote_revision := NULL;
  NEW.source_state := NULL;
  NEW.source_state_revision := NULL;
  PERFORM 1 FROM users actor WHERE actor.id = NEW.actor_user_id
    AND actor.account_state = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned quote context required'; END IF;
  SELECT * INTO source_conversation FROM current_conversations conversation
    WHERE conversation.id = NEW.conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned quote context required'; END IF;
  PERFORM 1 FROM job_invitations invitation
    WHERE invitation.id = source_conversation.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
    WHERE conversation.id = NEW.conversation_id FOR UPDATE;
  PERFORM 1 FROM job_requests request
    WHERE request.id = source_conversation.job_request_id FOR UPDATE;

  IF NEW.command_kind = 'CREATE_DRAFT' THEN
    IF NOT quote_active_participant_context(NEW.conversation_id,
        NEW.actor_user_id, 'CRAFTSMAN', false) THEN
      RAISE EXCEPTION 'owned quote context required';
    END IF;
    IF NOT quote_active_participant_context(NEW.conversation_id,
        NEW.actor_user_id, 'CRAFTSMAN', true) THEN
      RAISE EXCEPTION 'writable quote conversation required';
    END IF;
    IF EXISTS (SELECT 1 FROM quotes quote
      WHERE quote.conversation_id = NEW.conversation_id) THEN
      RAISE EXCEPTION 'quote lineage already exists for conversation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM job_request_active_content_revisions provenance
      WHERE provenance.job_request_id = source_conversation.job_request_id
        AND provenance.content_revision = NEW.request_content_revision
        AND provenance.visible_version = NEW.request_visible_version) THEN
      RAISE EXCEPTION 'exact quote request provenance required';
    END IF;
    NEW.quote_id := gen_random_uuid(); NEW.quote_revision := 1;
    NEW.expected_submitted_state_revision := NULL;
    NEW.resulting_state_revision := 1; NEW.created_quote_id := NEW.quote_id;
    NEW.created_revision_quote_id := NEW.quote_id;
    NEW.created_revision_number := 1; NEW.prior_quote_revision := NULL;
    NEW.prior_resulting_state_revision := NULL; NEW.prior_target_state := NULL;
  ELSE
    SELECT * INTO source_quote FROM quotes quote
      WHERE quote.id = NEW.quote_id AND quote.conversation_id = NEW.conversation_id
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'owned quote lineage required'; END IF;
    SELECT * INTO current_draft FROM current_quote_drafts draft
      WHERE draft.quote_id = source_quote.id;
    SELECT * INTO current_submitted FROM current_submitted_quotes submitted
      WHERE submitted.quote_id = source_quote.id;
    SELECT * INTO current_terminal FROM current_quote_revision_states current
      WHERE current.quote_id = source_quote.id
        AND current.state IN ('EXPIRED', 'WITHDRAWN')
        AND current.revision = (
          SELECT max(identity.revision) FROM quote_revision_identities identity
          WHERE identity.quote_id = source_quote.id
        )
      ORDER BY current.revision DESC LIMIT 1;

    IF NEW.command_kind IN ('CREATE_REVISION', 'SUBMIT') THEN
      IF NOT quote_active_participant_context(NEW.conversation_id,
          NEW.actor_user_id, 'CRAFTSMAN', false) THEN
        RAISE EXCEPTION 'owned quote context required'; END IF;
      IF NOT quote_active_participant_context(NEW.conversation_id,
          NEW.actor_user_id, 'CRAFTSMAN', true) THEN
        RAISE EXCEPTION 'writable quote conversation required'; END IF;
    ELSE
      IF NOT quote_active_participant_context(NEW.conversation_id,
          NEW.actor_user_id, 'CUSTOMER', false) THEN
        RAISE EXCEPTION 'owned quote context required'; END IF;
      IF NOT quote_active_participant_context(NEW.conversation_id,
          NEW.actor_user_id, 'CUSTOMER', true) THEN
        RAISE EXCEPTION 'writable quote conversation required'; END IF;
    END IF;

    IF NEW.command_kind = 'CREATE_REVISION' THEN
      SELECT item.* INTO current_request FROM job_request_active_content_revisions item
        JOIN current_job_requests request
          ON request.id = item.job_request_id AND request.state::text = 'ACTIVE'
        WHERE item.job_request_id = source_conversation.job_request_id
        ORDER BY item.content_revision DESC LIMIT 1 FOR UPDATE OF item;
      IF current_draft.quote_id IS NOT NULL
          OR (current_submitted.quote_id IS NULL AND current_terminal.quote_id IS NULL)
          OR coalesce(current_submitted.state_revision,
            current_terminal.state_revision) <> NEW.expected_submitted_state_revision THEN
        RAISE EXCEPTION 'quote revision creation transition is invalid or stale';
      END IF;
      IF current_request.job_request_id IS NULL
          OR NEW.request_content_revision <> current_request.content_revision
          OR NEW.request_visible_version <> current_request.visible_version THEN
        RAISE EXCEPTION 'exact current quote request provenance required';
      END IF;
      IF current_submitted.quote_id IS NOT NULL THEN
        NEW.source_quote_revision := current_submitted.revision;
        NEW.source_state := current_submitted.state;
        NEW.source_state_revision := current_submitted.state_revision;
      ELSE
        NEW.source_quote_revision := current_terminal.revision;
        NEW.source_state := current_terminal.state;
        NEW.source_state_revision := current_terminal.state_revision;
      END IF;
      SELECT coalesce(max(identity.revision), 0) + 1 INTO next_revision
        FROM quote_revision_identities identity WHERE identity.quote_id = source_quote.id;
      NEW.quote_revision := next_revision; NEW.resulting_state_revision := 1;
      NEW.created_quote_id := NULL; NEW.created_revision_quote_id := NEW.quote_id;
      NEW.created_revision_number := next_revision; NEW.prior_quote_revision := NULL;
      NEW.prior_resulting_state_revision := NULL; NEW.prior_target_state := NULL;
    ELSIF NEW.command_kind = 'SUBMIT' THEN
      IF current_draft.quote_id IS NULL OR current_draft.revision <> NEW.quote_revision
          OR current_draft.state_revision <> NEW.expected_draft_state_revision
          OR (current_submitted.quote_id IS NULL AND NEW.expected_submitted_state_revision IS NOT NULL)
          OR (current_submitted.quote_id IS NOT NULL AND current_submitted.state_revision
            IS DISTINCT FROM NEW.expected_submitted_state_revision) THEN
        RAISE EXCEPTION 'quote submission transition is invalid or stale';
      END IF;
      IF NOT quote_revision_authoring_is_eligible(source_quote.id,
          current_draft.revision, current_draft.authoring_mode) THEN
        RAISE EXCEPTION 'quote authoring is not ready for submission'; END IF;
      NEW.resulting_state_revision := current_draft.state_revision + 1;
      NEW.created_quote_id := NULL; NEW.created_revision_quote_id := NULL;
      NEW.created_revision_number := NULL;
      IF current_submitted.quote_id IS NULL THEN
        NEW.prior_quote_revision := NULL; NEW.prior_resulting_state_revision := NULL;
        NEW.prior_target_state := NULL;
      ELSE
        NEW.prior_quote_revision := current_submitted.revision;
        NEW.prior_resulting_state_revision := current_submitted.state_revision + 1;
        NEW.prior_target_state := 'SUPERSEDED';
      END IF;
    ELSIF NEW.command_kind = 'REJECT' THEN
      IF current_submitted.quote_id IS NULL OR current_submitted.revision <> NEW.quote_revision
          OR current_submitted.state_revision <> NEW.expected_submitted_state_revision THEN
        RAISE EXCEPTION 'quote rejection transition is invalid or stale'; END IF;
      NEW.resulting_state_revision := current_submitted.state_revision + 1;
      NEW.created_quote_id := NULL; NEW.created_revision_quote_id := NULL;
      NEW.created_revision_number := NULL; NEW.prior_quote_revision := NULL;
      NEW.prior_resulting_state_revision := NULL; NEW.prior_target_state := NULL;
    END IF;
  END IF;
  NEW.created_at := clock_timestamp(); RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_quote_revision_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_core_commands%ROWTYPE;
DECLARE lifecycle quote_lifecycle_commands%ROWTYPE;
DECLARE prior current_quote_revision_states%ROWTYPE;
BEGIN
  SELECT * INTO prior FROM current_quote_revision_states current
  WHERE current.quote_id = NEW.quote_id AND current.revision = NEW.quote_revision;
  IF NEW.lifecycle_command_id IS NOT NULL THEN
    SELECT * INTO lifecycle FROM quote_lifecycle_commands command
    WHERE command.command_id = NEW.lifecycle_command_id FOR UPDATE;
    IF lifecycle.command_id IS NULL OR lifecycle.quote_id <> NEW.quote_id
        OR lifecycle.quote_revision <> NEW.quote_revision
        OR prior.state <> 'SUBMITTED'
        OR prior.state_revision <> lifecycle.expected_state_revision
        OR NEW.state <> lifecycle.target_state THEN
      RAISE EXCEPTION 'invalid Quote lifecycle state event';
    END IF;
    NEW.command_id := NULL;
    NEW.state_revision := prior.state_revision + 1;
    NEW.submitted_at := prior.submitted_at;
    NEW.rejection_reason := NULL;
    NEW.changed_at := clock_timestamp();
    RETURN NEW;
  END IF;

  SELECT * INTO source FROM quote_core_commands command
  WHERE command.command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.quote_id <> NEW.quote_id THEN
    RAISE EXCEPTION 'quote state event requires exact command';
  END IF;
  IF source.command_kind IN ('CREATE_DRAFT', 'CREATE_REVISION') THEN
    IF prior.quote_id IS NOT NULL OR NEW.quote_revision <> source.quote_revision
        OR NEW.state <> 'DRAFT' THEN RAISE EXCEPTION 'invalid quote draft state event'; END IF;
    NEW.state_revision := 1; NEW.submitted_at := NULL; NEW.rejection_reason := NULL;
  ELSIF source.command_kind = 'SUBMIT' THEN
    IF NEW.quote_revision = source.quote_revision THEN
      IF prior.state <> 'DRAFT' OR prior.state_revision <> source.expected_draft_state_revision
          OR NEW.state <> 'SUBMITTED' THEN RAISE EXCEPTION 'invalid quote submission state event'; END IF;
      NEW.state_revision := prior.state_revision + 1; NEW.submitted_at := clock_timestamp();
    ELSE
      IF prior.state <> 'SUBMITTED' OR prior.state_revision <> source.expected_submitted_state_revision
          OR NEW.state <> 'SUPERSEDED' THEN RAISE EXCEPTION 'invalid quote supersession state event'; END IF;
      NEW.state_revision := prior.state_revision + 1; NEW.submitted_at := prior.submitted_at;
    END IF;
    NEW.rejection_reason := NULL;
  ELSIF source.command_kind = 'REJECT' THEN
    IF NEW.quote_revision <> source.quote_revision OR prior.state <> 'SUBMITTED'
        OR prior.state_revision <> source.expected_submitted_state_revision
        OR NEW.state <> 'REJECTED' THEN RAISE EXCEPTION 'invalid quote rejection state event'; END IF;
    NEW.state_revision := prior.state_revision + 1; NEW.submitted_at := prior.submitted_at;
    NEW.rejection_reason := source.rejection_reason;
  ELSE RAISE EXCEPTION 'unsupported quote core state event'; END IF;
  NEW.lifecycle_command_id := NULL;
  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE VIEW current_quote_acceptance_context WITH (security_invoker = true) AS
SELECT current.quote_id, current.revision AS quote_revision,
  current.state, current.state_revision, current.authoring_mode,
  current.request_content_revision, current.request_visible_version,
  active.content_revision AS current_request_content_revision,
  active.visible_version AS current_request_visible_version,
  quote_revision_valid_until(
    current.quote_id, current.revision, current.authoring_mode
  ) AS valid_until,
  quote_revision_authoring_is_eligible(
    current.quote_id, current.revision, current.authoring_mode
  ) AS authoring_eligible,
  (active.visible_version IS DISTINCT FROM current.request_visible_version)
    AS materially_stale,
  (quote_revision_valid_until(current.quote_id, current.revision,
    current.authoring_mode) IS NOT NULL
    AND quote_revision_valid_until(current.quote_id, current.revision,
      current.authoring_mode) <= clock_timestamp()) AS deadline_passed,
  (current.state = 'SUBMITTED'
    AND active.visible_version = current.request_visible_version
    AND quote_revision_authoring_is_eligible(
      current.quote_id, current.revision, current.authoring_mode)
    AND (quote_revision_valid_until(current.quote_id, current.revision,
      current.authoring_mode) IS NULL
      OR quote_revision_valid_until(current.quote_id, current.revision,
      current.authoring_mode) > clock_timestamp()))
    AS lifecycle_acceptance_eligible
FROM current_quote_revision_states current
JOIN quotes quote ON quote.id = current.quote_id
JOIN current_conversations conversation ON conversation.id = quote.conversation_id
JOIN current_job_requests request
  ON request.id = conversation.job_request_id AND request.state::text = 'ACTIVE'
JOIN current_job_request_active_content_versions active
  ON active.job_request_id = conversation.job_request_id;

CREATE FUNCTION reject_quote_lifecycle_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Quote lifecycle history is append-only'; END;
$$;
CREATE TRIGGER quote_lifecycle_commands_append_only
BEFORE UPDATE OR DELETE ON quote_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION reject_quote_lifecycle_mutation();

CREATE INDEX quote_lifecycle_commands_history_idx
  ON quote_lifecycle_commands (quote_id, quote_revision, created_at, command_id);

COMMENT ON VIEW current_quote_acceptance_context IS
  'Server-derived lifecycle-only D15/D16 facts. lifecycle_acceptance_eligible is not complete D16 acceptance authority; R4 must intersect every remaining actor, credential and immutable-document gate.';
