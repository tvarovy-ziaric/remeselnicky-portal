CREATE TYPE job_invitation_state AS ENUM (
  'PENDING', 'ENGAGED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'NOT_SELECTED'
);
CREATE TYPE job_invitation_command_kind AS ENUM (
  'SEND', 'ENGAGE', 'DECLINE', 'CUSTOMER_WITHDRAW', 'CUSTOMER_STOP',
  'CRAFTSMAN_WITHDRAW', 'EXPIRE', 'REQUEST_CLOSED', 'NOT_SELECT'
);
CREATE TYPE job_invitation_decline_reason AS ENUM (
  'NO_CAPACITY', 'NOT_MY_WORK', 'OTHER', 'TIMING', 'TOO_FAR'
);

CREATE TABLE job_invitation_runtime_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_invitation_limit integer NOT NULL DEFAULT 5
    CHECK (active_invitation_limit BETWEEN 1 AND 100),
  expiry_days integer NOT NULL DEFAULT 7
    CHECK (expiry_days BETWEEN 1 AND 365),
  warning_lead_days integer NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_invitation_runtime_warning_valid CHECK (
    warning_lead_days BETWEEN 0 AND expiry_days
  )
);
INSERT INTO job_invitation_runtime_policy DEFAULT VALUES;

CREATE TABLE job_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  request_content_revision integer NOT NULL,
  request_visible_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_invitations_pair_once UNIQUE (
    job_request_id, craftsman_profile_id
  ),
  CONSTRAINT job_invitations_version_positive CHECK (
    request_content_revision > 0 AND request_visible_version > 0
  )
);

CREATE TABLE job_invitation_commands (
  command_id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL
    REFERENCES job_invitations(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  command_kind job_invitation_command_kind NOT NULL,
  expected_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  target_state job_invitation_state NOT NULL,
  system_initiated boolean NOT NULL DEFAULT false,
  decline_reason job_invitation_decline_reason,
  decline_note varchar(500),
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_invitation_commands_revision_shape CHECK (
    expected_revision >= 0 AND resulting_revision = expected_revision + 1
  ),
  CONSTRAINT job_invitation_commands_actor_shape CHECK (
    (command_kind IN ('EXPIRE', 'REQUEST_CLOSED', 'NOT_SELECT')
      AND system_initiated AND actor_user_id IS NULL)
    OR (command_kind NOT IN ('EXPIRE', 'REQUEST_CLOSED', 'NOT_SELECT')
      AND NOT system_initiated AND actor_user_id IS NOT NULL)
  ),
  CONSTRAINT job_invitation_commands_decline_shape CHECK (
    command_kind = 'DECLINE'
    OR (decline_reason IS NULL AND decline_note IS NULL)
  ),
  CONSTRAINT job_invitation_commands_decline_note_safe CHECK (
    decline_note IS NULL OR (
      decline_note = btrim(decline_note)
      AND length(decline_note) BETWEEN 1 AND 500
      AND decline_note !~ '[[:cntrl:]]'
      AND decline_note !~* '[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}'
      AND decline_note !~ '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)'
      AND decline_note !~* '(https?://|www\.)'
    )
  ),
  CONSTRAINT job_invitation_commands_fingerprint_sha256 CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE job_invitation_revisions (
  invitation_id uuid NOT NULL
    REFERENCES job_invitations(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES job_invitation_commands(command_id) ON DELETE RESTRICT,
  state job_invitation_state NOT NULL,
  changed_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  engaged_at timestamptz,
  decline_reason job_invitation_decline_reason,
  decline_note varchar(500),
  PRIMARY KEY (invitation_id, revision),
  CONSTRAINT job_invitation_revisions_positive CHECK (revision > 0),
  CONSTRAINT job_invitation_revisions_state_shape CHECK (
    (state = 'PENDING' AND engaged_at IS NULL
      AND decline_reason IS NULL AND decline_note IS NULL)
    OR (state = 'ENGAGED' AND engaged_at IS NOT NULL
      AND decline_reason IS NULL AND decline_note IS NULL)
    OR (state = 'DECLINED' AND engaged_at IS NULL)
    OR (state IN ('EXPIRED', 'WITHDRAWN', 'NOT_SELECTED')
      AND decline_reason IS NULL AND decline_note IS NULL)
  )
);

CREATE INDEX job_invitation_commands_history_idx
  ON job_invitation_commands (invitation_id, resulting_revision, command_id);
CREATE INDEX job_invitations_customer_idx
  ON job_invitations (customer_profile_id, created_at DESC, id);
CREATE INDEX job_invitations_craftsman_idx
  ON job_invitations (craftsman_profile_id, created_at DESC, id);

CREATE VIEW current_job_invitations AS
SELECT DISTINCT ON (invitation.id)
  invitation.id, invitation.job_request_id, invitation.customer_profile_id,
  invitation.craftsman_profile_id, invitation.request_content_revision,
  invitation.request_visible_version, revision.revision, revision.state,
  invitation.created_at, revision.changed_at, revision.sent_at,
  revision.expires_at, revision.engaged_at, revision.decline_reason,
  revision.decline_note
FROM job_invitations invitation
JOIN job_invitation_revisions revision
  ON revision.invitation_id = invitation.id
ORDER BY invitation.id, revision.revision DESC;

CREATE FUNCTION validate_job_invitation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  customer_owner uuid;
  craftsman_owner uuid;
  content_revision integer;
  visible_version integer;
  request_customer uuid;
  active_count integer;
  active_limit integer;
  primary_profession text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.job_request_id::text, 41007)
  );
  SELECT customer.owner_user_id, request.customer_profile_id,
      content.content_revision, content.visible_version
    INTO customer_owner, request_customer, content_revision, visible_version
  FROM job_requests request
  JOIN current_job_requests lifecycle ON lifecycle.id = request.id
    AND lifecycle.state::text = 'ACTIVE'
  JOIN current_job_request_active_content_versions content
    ON content.job_request_id = request.id
  JOIN customer_profiles customer ON customer.id = request.customer_profile_id
  WHERE request.id = NEW.job_request_id
  FOR UPDATE OF request, customer;
  IF NOT FOUND OR request_customer <> NEW.customer_profile_id THEN
    RAISE EXCEPTION 'active owned request required for invitation';
  END IF;
  SELECT publication.owner_user_id INTO craftsman_owner
  FROM current_craftsman_profile_publications publication
  JOIN craftsman_profiles profile
    ON profile.id = publication.craftsman_profile_id
  WHERE publication.craftsman_profile_id = NEW.craftsman_profile_id
    AND publication.effectively_public
  FOR UPDATE OF profile;
  IF NOT FOUND OR craftsman_owner = customer_owner THEN
    RAISE EXCEPTION 'eligible non-self public craftsman required';
  END IF;
  SELECT section.payload ->> 'primaryProfessionCode'
    INTO primary_profession
  FROM current_job_request_active_sections section
  WHERE section.job_request_id = NEW.job_request_id
    AND section.section_key = 'request.core';
  IF primary_profession IS NULL OR EXISTS (
    SELECT 1 FROM current_credential_qualification_policies policy
    WHERE policy.profession_code = primary_profession
      AND policy.requirement = 'REQUIRED'
      AND NOT EXISTS (
        SELECT 1 FROM current_searchable_craftsman_credentials credential
        WHERE credential.craftsman_profile_id = NEW.craftsman_profile_id
          AND credential.profession_code = primary_profession
          AND credential.credential_type_code = policy.credential_type_code
      )
  ) THEN
    RAISE EXCEPTION 'required craftsman qualification missing';
  END IF;
  SELECT active_invitation_limit INTO active_limit
  FROM job_invitation_runtime_policy;
  SELECT count(*)::integer INTO active_count FROM current_job_invitations current
  WHERE current.job_request_id = NEW.job_request_id
    AND current.state IN ('PENDING', 'ENGAGED');
  IF active_count >= active_limit THEN
    RAISE EXCEPTION 'active invitation limit reached';
  END IF;
  NEW.request_content_revision := content_revision;
  NEW.request_visible_version := visible_version;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_invitations_identity_guard
BEFORE INSERT ON job_invitations
FOR EACH ROW EXECUTE FUNCTION validate_job_invitation_identity();

CREATE FUNCTION validate_job_invitation_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity job_invitations%ROWTYPE;
  current_revision job_invitation_revisions%ROWTYPE;
  customer_owner uuid;
  craftsman_owner uuid;
  actor_state user_account_state;
  actor_email_verified timestamptz;
  actor_phone_verified timestamptz;
  kind text := NEW.command_kind::text;
BEGIN
  SELECT * INTO identity FROM job_invitations
  WHERE id = NEW.invitation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation identity required'; END IF;
  SELECT * INTO current_revision FROM job_invitation_revisions
  WHERE invitation_id = NEW.invitation_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF kind IN ('EXPIRE', 'REQUEST_CLOSED', 'NOT_SELECT') THEN
    IF NOT NEW.system_initiated OR NEW.actor_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'system invitation command required';
    END IF;
  ELSE
    SELECT owner_user_id INTO customer_owner FROM customer_profiles
    WHERE id = identity.customer_profile_id FOR UPDATE;
    SELECT owner_user_id INTO craftsman_owner FROM craftsman_profiles
    WHERE id = identity.craftsman_profile_id FOR UPDATE;
    SELECT account_state, email_verified_at, phone_verified_at
      INTO actor_state, actor_email_verified, actor_phone_verified
    FROM users WHERE id = NEW.actor_user_id FOR UPDATE;
    IF NOT FOUND OR actor_state <> 'ACTIVE'
       OR actor_email_verified IS NULL OR actor_phone_verified IS NULL THEN
      RAISE EXCEPTION 'active verified invitation actor required';
    END IF;
    IF kind IN ('SEND', 'CUSTOMER_WITHDRAW', 'CUSTOMER_STOP')
       AND NEW.actor_user_id <> customer_owner THEN
      RAISE EXCEPTION 'owning customer actor required';
    END IF;
    IF kind IN ('ENGAGE', 'DECLINE', 'CRAFTSMAN_WITHDRAW')
       AND NEW.actor_user_id <> craftsman_owner THEN
      RAISE EXCEPTION 'invited craftsman actor required';
    END IF;
  END IF;

  IF kind = 'SEND' THEN
    IF current_revision.invitation_id IS NOT NULL
       OR NEW.expected_revision <> 0 OR NEW.target_state <> 'PENDING' THEN
      RAISE EXCEPTION 'invitation send must initialize pending state';
    END IF;
  ELSIF current_revision.invitation_id IS NULL
      OR current_revision.revision <> NEW.expected_revision THEN
    RAISE EXCEPTION 'invitation command is stale';
  ELSIF kind = 'ENGAGE' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'ENGAGED'
    ) THEN RAISE EXCEPTION 'engagement transition is invalid';
  ELSIF kind = 'DECLINE' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'DECLINED'
    ) THEN RAISE EXCEPTION 'decline transition is invalid';
  ELSIF kind = 'CUSTOMER_WITHDRAW' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'WITHDRAWN'
    ) THEN RAISE EXCEPTION 'withdraw transition is invalid';
  ELSIF kind = 'CUSTOMER_STOP' AND NOT (
      current_revision.state = 'ENGAGED' AND NEW.target_state = 'NOT_SELECTED'
    ) THEN RAISE EXCEPTION 'stop transition is invalid';
  ELSIF kind = 'CRAFTSMAN_WITHDRAW' AND NOT (
      current_revision.state = 'ENGAGED' AND NEW.target_state = 'WITHDRAWN'
    ) THEN RAISE EXCEPTION 'craftsman withdrawal transition is invalid';
  ELSIF kind = 'EXPIRE' AND NOT (
      current_revision.state = 'PENDING' AND NEW.target_state = 'EXPIRED'
      AND current_revision.expires_at <= clock_timestamp()
    ) THEN RAISE EXCEPTION 'invitation expiry transition is invalid';
  ELSIF kind = 'REQUEST_CLOSED' AND NOT (
      current_revision.state IN ('PENDING', 'ENGAGED')
      AND NEW.target_state = 'WITHDRAWN'
    ) THEN RAISE EXCEPTION 'request closure transition is invalid';
  ELSIF kind = 'NOT_SELECT' AND NOT (
      current_revision.state IN ('PENDING', 'ENGAGED')
      AND NEW.target_state = 'NOT_SELECTED'
    ) THEN RAISE EXCEPTION 'not-selected transition is invalid';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_invitation_commands_guard
BEFORE INSERT ON job_invitation_commands
FOR EACH ROW EXECUTE FUNCTION validate_job_invitation_command();

CREATE FUNCTION validate_job_invitation_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source job_invitation_commands%ROWTYPE;
  prior job_invitation_revisions%ROWTYPE;
  expiry integer;
BEGIN
  SELECT * INTO source FROM job_invitation_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.invitation_id <> NEW.invitation_id
     OR source.resulting_revision <> NEW.revision
     OR source.target_state <> NEW.state THEN
    RAISE EXCEPTION 'invitation revision must match command';
  END IF;
  SELECT * INTO prior FROM job_invitation_revisions
  WHERE invitation_id = NEW.invitation_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF source.command_kind = 'SEND' THEN
    IF prior.invitation_id IS NOT NULL OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'initial invitation revision is invalid';
    END IF;
    SELECT expiry_days INTO expiry FROM job_invitation_runtime_policy;
    NEW.sent_at := source.created_at;
    NEW.expires_at := source.created_at + make_interval(days => expiry);
  ELSIF prior.invitation_id IS NULL
      OR prior.revision <> source.expected_revision THEN
    RAISE EXCEPTION 'invitation revision sequence is invalid';
  ELSE
    NEW.sent_at := prior.sent_at;
    NEW.expires_at := prior.expires_at;
  END IF;
  NEW.changed_at := source.created_at;
  NEW.engaged_at := CASE WHEN NEW.state = 'ENGAGED'
    THEN source.created_at ELSE prior.engaged_at END;
  NEW.decline_reason := CASE WHEN NEW.state = 'DECLINED'
    THEN source.decline_reason ELSE NULL END;
  NEW.decline_note := CASE WHEN NEW.state = 'DECLINED'
    THEN source.decline_note ELSE NULL END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_invitation_revisions_guard
BEFORE INSERT ON job_invitation_revisions
FOR EACH ROW EXECUTE FUNCTION validate_job_invitation_revision();

CREATE FUNCTION close_job_invitations_with_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invitation record;
  closure_command_id uuid;
  closure_state job_invitation_state;
BEGIN
  IF NEW.state::text NOT IN ('CANCELLED', 'EXPIRED') THEN RETURN NEW; END IF;
  FOR invitation IN
    SELECT identity.id, current.revision, current.state
    FROM job_invitations identity
    JOIN current_job_invitations current ON current.id = identity.id
    WHERE identity.job_request_id = NEW.job_request_id
      AND current.state IN ('PENDING', 'ENGAGED')
    ORDER BY identity.id FOR UPDATE OF identity
  LOOP
    closure_command_id := gen_random_uuid();
    closure_state := 'WITHDRAWN'::job_invitation_state;
    INSERT INTO job_invitation_commands (
      command_id, invitation_id, actor_user_id, command_kind,
      expected_revision, resulting_revision, target_state,
      system_initiated, decline_reason, decline_note, payload_fingerprint
    ) VALUES (
      closure_command_id, invitation.id, NULL, 'REQUEST_CLOSED',
      invitation.revision, invitation.revision + 1, closure_state,
      true, NULL, NULL, repeat('0', 64)
    );
    INSERT INTO job_invitation_revisions (
      invitation_id, revision, command_id, state, changed_at, sent_at,
      expires_at, engaged_at, decline_reason, decline_note
    ) VALUES (
      invitation.id, invitation.revision + 1, closure_command_id,
      closure_state, clock_timestamp(), clock_timestamp(),
      clock_timestamp(), NULL, NULL, NULL
    );
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_request_closes_active_invitations
AFTER INSERT ON job_request_revisions
FOR EACH ROW EXECUTE FUNCTION close_job_invitations_with_request();

CREATE FUNCTION ensure_job_invitation_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_invitation_revisions revision
    WHERE revision.command_id = NEW.command_id
      AND revision.invitation_id = NEW.invitation_id
      AND revision.revision = NEW.resulting_revision
      AND revision.state = NEW.target_state
  ) THEN RAISE EXCEPTION 'invitation command requires exact effect'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER job_invitation_command_effect_required
AFTER INSERT ON job_invitation_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_job_invitation_command_effect();

CREATE FUNCTION ensure_job_invitation_initialized()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_invitation_revisions revision
    WHERE revision.invitation_id = NEW.id AND revision.revision = 1
      AND revision.state = 'PENDING'
  ) THEN RAISE EXCEPTION 'invitation identity requires pending revision'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER job_invitation_identity_initialized
AFTER INSERT ON job_invitations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_job_invitation_initialized();

CREATE FUNCTION reject_job_invitation_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'job invitation history is append-only'; END;
$$;
CREATE TRIGGER job_invitations_append_only
BEFORE UPDATE OR DELETE ON job_invitations
FOR EACH ROW EXECUTE FUNCTION reject_job_invitation_history_mutation();
CREATE TRIGGER job_invitation_commands_append_only
BEFORE UPDATE OR DELETE ON job_invitation_commands
FOR EACH ROW EXECUTE FUNCTION reject_job_invitation_history_mutation();
CREATE TRIGGER job_invitation_revisions_append_only
BEFORE UPDATE OR DELETE ON job_invitation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_job_invitation_history_mutation();

COMMENT ON TABLE job_invitations IS
  'One immutable invitation lineage per JobRequest and CraftsmanProfile; never a broadcast.';
COMMENT ON TABLE job_invitation_runtime_policy IS
  'Offline-configurable active-five and expiry policy; no customer/public mutation API.';
