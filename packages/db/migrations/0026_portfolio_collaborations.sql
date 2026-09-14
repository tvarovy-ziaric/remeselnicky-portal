CREATE TYPE portfolio_collaboration_state AS ENUM (
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'AUTHOR_WITHDRAWN',
  'COLLABORATOR_WITHDRAWN'
);
CREATE TYPE portfolio_collaboration_visibility AS ENUM ('VISIBLE', 'HIDDEN');
CREATE TYPE portfolio_collaboration_actor_kind AS ENUM ('AUTHOR', 'COLLABORATOR');
CREATE TYPE portfolio_collaboration_command_kind AS ENUM (
  'INVITE',
  'EDIT_PENDING',
  'AUTHOR_WITHDRAW',
  'COLLABORATOR_ACCEPT',
  'COLLABORATOR_DECLINE',
  'COLLABORATOR_WITHDRAW',
  'HIDE',
  'SHOW'
);

CREATE TABLE portfolio_collaborations (
  id uuid PRIMARY KEY,
  portfolio_project_id uuid NOT NULL
    REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  author_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  collaborator_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  state portfolio_collaboration_state NOT NULL DEFAULT 'PENDING',
  visibility portfolio_collaboration_visibility NOT NULL DEFAULT 'VISIBLE',
  role text NOT NULL,
  contribution text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  latest_command_id uuid NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT portfolio_collaborations_distinct_profiles CHECK (
    author_profile_id <> collaborator_profile_id
  ),
  CONSTRAINT portfolio_collaborations_attribution_safe CHECK (
    role = btrim(role)
    AND length(role) BETWEEN 2 AND 120
    AND portfolio_project_public_text_safe(role)
    AND contribution = btrim(contribution)
    AND length(contribution) BETWEEN 2 AND 600
    AND portfolio_project_public_text_safe(contribution)
  ),
  CONSTRAINT portfolio_collaborations_revision_positive CHECK (revision > 0),
  CONSTRAINT portfolio_collaborations_acceptance_shape CHECK (
    (accepted_at IS NOT NULL) =
      (state IN ('ACCEPTED', 'COLLABORATOR_WITHDRAWN'))
  ),
  CONSTRAINT portfolio_collaborations_terminal_shape CHECK (
    (terminal_at IS NOT NULL) =
      (state IN ('DECLINED', 'AUTHOR_WITHDRAWN', 'COLLABORATOR_WITHDRAWN'))
  ),
  CONSTRAINT portfolio_collaborations_timestamps_ordered CHECK (
    updated_at >= invited_at
    AND (accepted_at IS NULL OR accepted_at >= invited_at)
    AND (terminal_at IS NULL OR terminal_at >= invited_at)
  )
);

CREATE UNIQUE INDEX portfolio_collaborations_one_live_pair_idx
  ON portfolio_collaborations (portfolio_project_id, collaborator_profile_id)
  WHERE state IN ('PENDING', 'ACCEPTED');
CREATE INDEX portfolio_collaborations_author_timeline_idx
  ON portfolio_collaborations (author_profile_id, updated_at DESC, id);
CREATE INDEX portfolio_collaborations_collaborator_timeline_idx
  ON portfolio_collaborations (collaborator_profile_id, updated_at DESC, id);

CREATE TABLE portfolio_collaboration_commands (
  command_id uuid PRIMARY KEY,
  command_kind portfolio_collaboration_command_kind NOT NULL,
  collaboration_id uuid NOT NULL
    REFERENCES portfolio_collaborations(id) ON DELETE RESTRICT,
  portfolio_project_id uuid NOT NULL
    REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  actor_kind portfolio_collaboration_actor_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  requested_role text,
  requested_contribution text,
  payload_fingerprint char(64) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT portfolio_collaboration_commands_revision_valid CHECK (
    expected_revision >= 0 AND resulting_revision > 0
  ),
  CONSTRAINT portfolio_collaboration_commands_fingerprint_valid CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT portfolio_collaboration_commands_actor_shape CHECK (
    (
      actor_kind = 'AUTHOR'
      AND command_kind IN (
        'INVITE', 'EDIT_PENDING', 'AUTHOR_WITHDRAW', 'HIDE', 'SHOW'
      )
    ) OR (
      actor_kind = 'COLLABORATOR'
      AND command_kind IN (
        'COLLABORATOR_ACCEPT', 'COLLABORATOR_DECLINE',
        'COLLABORATOR_WITHDRAW'
      )
    )
  ),
  CONSTRAINT portfolio_collaboration_commands_content_shape CHECK (
    (
      command_kind IN ('INVITE', 'EDIT_PENDING')
      AND requested_role IS NOT NULL
      AND requested_contribution IS NOT NULL
    ) OR (
      command_kind NOT IN ('INVITE', 'EDIT_PENDING')
      AND requested_role IS NULL
      AND requested_contribution IS NULL
    )
  ),
  CONSTRAINT portfolio_collaboration_commands_content_safe CHECK (
    (requested_role IS NULL OR (
      requested_role = btrim(requested_role)
      AND length(requested_role) BETWEEN 2 AND 120
      AND portfolio_project_public_text_safe(requested_role)
    ))
    AND (requested_contribution IS NULL OR (
      requested_contribution = btrim(requested_contribution)
      AND length(requested_contribution) BETWEEN 2 AND 600
      AND portfolio_project_public_text_safe(requested_contribution)
    ))
  )
);

ALTER TABLE portfolio_collaborations
ADD CONSTRAINT portfolio_collaborations_latest_command_fkey
FOREIGN KEY (latest_command_id)
REFERENCES portfolio_collaboration_commands(command_id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE portfolio_collaboration_revisions (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL UNIQUE
    REFERENCES portfolio_collaboration_commands(command_id) ON DELETE RESTRICT,
  collaboration_id uuid NOT NULL
    REFERENCES portfolio_collaborations(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  state portfolio_collaboration_state NOT NULL,
  visibility portfolio_collaboration_visibility NOT NULL,
  role text NOT NULL,
  contribution text NOT NULL,
  accepted_at timestamptz,
  terminal_at timestamptz,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT portfolio_collaboration_revisions_lineage_revision_key
    UNIQUE (collaboration_id, revision),
  CONSTRAINT portfolio_collaboration_revisions_revision_positive CHECK (
    revision > 0
  ),
  CONSTRAINT portfolio_collaboration_revisions_attribution_safe CHECK (
    role = btrim(role)
    AND length(role) BETWEEN 2 AND 120
    AND portfolio_project_public_text_safe(role)
    AND contribution = btrim(contribution)
    AND length(contribution) BETWEEN 2 AND 600
    AND portfolio_project_public_text_safe(contribution)
  ),
  CONSTRAINT portfolio_collaboration_revisions_acceptance_shape CHECK (
    (accepted_at IS NOT NULL) =
      (state IN ('ACCEPTED', 'COLLABORATOR_WITHDRAWN'))
  ),
  CONSTRAINT portfolio_collaboration_revisions_terminal_shape CHECK (
    (terminal_at IS NOT NULL) =
      (state IN ('DECLINED', 'AUTHOR_WITHDRAWN', 'COLLABORATOR_WITHDRAWN'))
  )
);

CREATE OR REPLACE FUNCTION lock_portfolio_collaboration_author(
  target_project_id uuid,
  target_author_profile_id uuid,
  target_actor_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  project portfolio_projects%ROWTYPE;
  profile_owner_id uuid;
  profile_owner_state user_account_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO profile_owner_id, profile_owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = target_author_profile_id
  FOR UPDATE OF profile, owner;
  IF profile_owner_id IS DISTINCT FROM target_actor_user_id
     OR profile_owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active portfolio author collaboration context required';
  END IF;
  SELECT * INTO project
  FROM portfolio_projects
  WHERE id = target_project_id
  FOR UPDATE;
  IF project.id IS NULL
     OR project.craftsman_profile_id IS DISTINCT FROM target_author_profile_id
     OR project.author_user_id IS DISTINCT FROM target_actor_user_id
     OR project.record_state = 'ARCHIVED' THEN
    RAISE EXCEPTION 'active portfolio author collaboration context required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION lock_portfolio_collaboration_invitation(
  target_project_id uuid,
  target_author_profile_id uuid,
  target_collaborator_profile_id uuid,
  target_actor_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  locked record;
  author_owner_id uuid;
  author_owner_state user_account_state;
  collaborator_owner_id uuid;
  collaborator_owner_state user_account_state;
  project portfolio_projects%ROWTYPE;
BEGIN
  FOR locked IN
    SELECT profile.id, profile.owner_user_id, owner.account_state
    FROM craftsman_profiles profile
    JOIN users owner ON owner.id = profile.owner_user_id
    WHERE profile.id IN (
      target_author_profile_id, target_collaborator_profile_id
    )
    ORDER BY profile.id
    FOR UPDATE OF profile, owner
  LOOP
    IF locked.id = target_author_profile_id THEN
      author_owner_id := locked.owner_user_id;
      author_owner_state := locked.account_state;
    END IF;
    IF locked.id = target_collaborator_profile_id THEN
      collaborator_owner_id := locked.owner_user_id;
      collaborator_owner_state := locked.account_state;
    END IF;
  END LOOP;
  IF target_author_profile_id = target_collaborator_profile_id
     OR author_owner_id IS DISTINCT FROM target_actor_user_id
     OR author_owner_state <> 'ACTIVE'
     OR collaborator_owner_id IS NULL
     OR collaborator_owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active distinct portfolio collaboration invitation required';
  END IF;
  SELECT * INTO project
  FROM portfolio_projects
  WHERE id = target_project_id
  FOR UPDATE;
  IF project.id IS NULL
     OR project.craftsman_profile_id IS DISTINCT FROM target_author_profile_id
     OR project.author_user_id IS DISTINCT FROM target_actor_user_id
     OR project.record_state = 'ARCHIVED' THEN
    RAISE EXCEPTION 'active distinct portfolio collaboration invitation required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION lock_portfolio_collaboration_collaborator(
  target_collaborator_profile_id uuid,
  target_actor_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  profile_owner_id uuid;
  profile_owner_state user_account_state;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO profile_owner_id, profile_owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = target_collaborator_profile_id
  FOR UPDATE OF profile, owner;
  IF profile_owner_id IS DISTINCT FROM target_actor_user_id
     OR profile_owner_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active invited collaborator required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_portfolio_collaboration_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM lock_portfolio_collaboration_invitation(
    NEW.portfolio_project_id, NEW.author_profile_id,
    NEW.collaborator_profile_id,
    (SELECT author_user_id FROM portfolio_projects
      WHERE id = NEW.portfolio_project_id)
  );
  IF NEW.state <> 'PENDING' OR NEW.visibility <> 'VISIBLE'
     OR NEW.revision <> 1 OR NEW.accepted_at IS NOT NULL
     OR NEW.terminal_at IS NOT NULL THEN
    RAISE EXCEPTION 'valid active distinct collaborator invitation required';
  END IF;
  NEW.invited_at := clock_timestamp();
  NEW.updated_at := NEW.invited_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_collaboration_insert_guard
BEFORE INSERT ON portfolio_collaborations
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_collaboration_insert();

CREATE OR REPLACE FUNCTION enforce_portfolio_collaboration_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE current portfolio_collaborations%ROWTYPE;
BEGIN
  SELECT * INTO current
  FROM portfolio_collaborations
  WHERE id = NEW.collaboration_id;
  IF current.id IS NULL
     OR current.portfolio_project_id IS DISTINCT FROM NEW.portfolio_project_id THEN
    RAISE EXCEPTION 'portfolio collaboration command target mismatch';
  END IF;
  IF NEW.actor_kind = 'AUTHOR' THEN
    PERFORM lock_portfolio_collaboration_author(
      current.portfolio_project_id, current.author_profile_id, NEW.actor_user_id
    );
  ELSE
    PERFORM lock_portfolio_collaboration_collaborator(
      current.collaborator_profile_id, NEW.actor_user_id
    );
  END IF;
  SELECT * INTO current
  FROM portfolio_collaborations
  WHERE id = NEW.collaboration_id
  FOR UPDATE;
  IF current.id IS NULL
     OR current.portfolio_project_id IS DISTINCT FROM NEW.portfolio_project_id THEN
    RAISE EXCEPTION 'portfolio collaboration command target mismatch';
  END IF;
  IF NEW.command_kind = 'INVITE' THEN
    IF NEW.actor_kind <> 'AUTHOR' OR NEW.expected_revision <> 0
       OR current.revision <> 1
       OR current.latest_command_id IS DISTINCT FROM NEW.command_id
       OR NEW.requested_role IS DISTINCT FROM current.role
       OR NEW.requested_contribution IS DISTINCT FROM current.contribution THEN
      RAISE EXCEPTION 'invalid portfolio collaborator invite command';
    END IF;
    NEW.resulting_revision := 1;
  ELSIF NEW.expected_revision <> current.revision THEN
    RAISE EXCEPTION 'stale portfolio collaboration command revision';
  ELSE
    NEW.resulting_revision := current.revision + 1;
  END IF;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_collaboration_command_guard
BEFORE INSERT ON portfolio_collaboration_commands
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_collaboration_command();

CREATE OR REPLACE FUNCTION enforce_portfolio_collaboration_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE command portfolio_collaboration_commands%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.portfolio_project_id IS DISTINCT FROM OLD.portfolio_project_id
     OR NEW.author_profile_id IS DISTINCT FROM OLD.author_profile_id
     OR NEW.collaborator_profile_id IS DISTINCT FROM OLD.collaborator_profile_id
     OR NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
    RAISE EXCEPTION 'portfolio collaboration identity and invitation provenance are immutable';
  END IF;
  SELECT * INTO command
  FROM portfolio_collaboration_commands
  WHERE command_id = NEW.latest_command_id
  FOR UPDATE;
  IF command.command_id IS NULL OR command.command_kind = 'INVITE'
     OR command.collaboration_id IS DISTINCT FROM OLD.id
     OR command.portfolio_project_id IS DISTINCT FROM OLD.portfolio_project_id
     OR command.expected_revision IS DISTINCT FROM OLD.revision
     OR command.resulting_revision IS DISTINCT FROM OLD.revision + 1
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'portfolio collaboration update requires exact command provenance';
  END IF;

  IF command.command_kind = 'COLLABORATOR_ACCEPT' THEN
    NEW.accepted_at := command.occurred_at;
    NEW.terminal_at := NULL;
  ELSIF command.command_kind IN (
    'AUTHOR_WITHDRAW', 'COLLABORATOR_DECLINE', 'COLLABORATOR_WITHDRAW'
  ) THEN
    NEW.terminal_at := command.occurred_at;
  END IF;

  IF command.command_kind = 'EDIT_PENDING' THEN
    IF OLD.state <> 'PENDING' OR NEW.state <> 'PENDING'
       OR NEW.visibility IS DISTINCT FROM OLD.visibility
       OR NEW.role IS DISTINCT FROM command.requested_role
       OR NEW.contribution IS DISTINCT FROM command.requested_contribution
       OR ROW(NEW.role, NEW.contribution) IS NOT DISTINCT FROM
          ROW(OLD.role, OLD.contribution)
       OR NEW.accepted_at IS NOT NULL OR NEW.terminal_at IS NOT NULL THEN
      RAISE EXCEPTION 'invalid pending collaboration edit';
    END IF;
  ELSE
    IF ROW(NEW.role, NEW.contribution) IS DISTINCT FROM
       ROW(OLD.role, OLD.contribution) THEN
      RAISE EXCEPTION 'collaboration state command cannot rewrite attribution';
    END IF;
    IF command.command_kind = 'AUTHOR_WITHDRAW' AND NOT (
      OLD.state = 'PENDING' AND NEW.state = 'AUTHOR_WITHDRAWN'
      AND NEW.accepted_at IS NULL AND NEW.terminal_at IS NOT NULL
    ) THEN RAISE EXCEPTION 'invalid author withdrawal';
    ELSIF command.command_kind = 'COLLABORATOR_ACCEPT' AND NOT (
      OLD.state = 'PENDING' AND NEW.state = 'ACCEPTED'
      AND NEW.accepted_at IS NOT NULL AND NEW.terminal_at IS NULL
    ) THEN RAISE EXCEPTION 'invalid collaborator acceptance';
    ELSIF command.command_kind = 'COLLABORATOR_DECLINE' AND NOT (
      OLD.state = 'PENDING' AND NEW.state = 'DECLINED'
      AND NEW.accepted_at IS NULL AND NEW.terminal_at IS NOT NULL
    ) THEN RAISE EXCEPTION 'invalid collaborator decline';
    ELSIF command.command_kind = 'COLLABORATOR_WITHDRAW' AND NOT (
      OLD.state = 'ACCEPTED' AND NEW.state = 'COLLABORATOR_WITHDRAWN'
      AND NEW.accepted_at IS NOT NULL AND NEW.accepted_at = OLD.accepted_at
      AND NEW.terminal_at IS NOT NULL
    ) THEN RAISE EXCEPTION 'invalid accepted attribution withdrawal';
    ELSIF command.command_kind = 'HIDE' AND NOT (
      OLD.state = 'ACCEPTED' AND NEW.state = 'ACCEPTED'
      AND OLD.visibility = 'VISIBLE' AND NEW.visibility = 'HIDDEN'
      AND NEW.accepted_at = OLD.accepted_at AND NEW.terminal_at IS NULL
    ) THEN RAISE EXCEPTION 'invalid collaboration hide';
    ELSIF command.command_kind = 'SHOW' AND NOT (
      OLD.state = 'ACCEPTED' AND NEW.state = 'ACCEPTED'
      AND OLD.visibility = 'HIDDEN' AND NEW.visibility = 'VISIBLE'
      AND NEW.accepted_at = OLD.accepted_at AND NEW.terminal_at IS NULL
    ) THEN RAISE EXCEPTION 'invalid collaboration show';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_collaboration_update_guard
BEFORE UPDATE ON portfolio_collaborations
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_collaboration_update();

CREATE OR REPLACE FUNCTION enforce_portfolio_collaboration_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE current portfolio_collaborations%ROWTYPE; command portfolio_collaboration_commands%ROWTYPE;
BEGIN
  SELECT * INTO current FROM portfolio_collaborations
  WHERE id = NEW.collaboration_id FOR UPDATE;
  SELECT * INTO command FROM portfolio_collaboration_commands
  WHERE command_id = NEW.command_id FOR UPDATE;
  IF current.id IS NULL OR command.command_id IS NULL
     OR command.collaboration_id IS DISTINCT FROM current.id
     OR current.latest_command_id IS DISTINCT FROM command.command_id
     OR NEW.revision IS DISTINCT FROM current.revision
     OR NEW.actor_user_id IS DISTINCT FROM command.actor_user_id
     OR ROW(NEW.state, NEW.visibility, NEW.role, NEW.contribution,
            NEW.accepted_at, NEW.terminal_at)
        IS DISTINCT FROM
        ROW(current.state, current.visibility, current.role,
            current.contribution, current.accepted_at, current.terminal_at) THEN
    RAISE EXCEPTION 'portfolio collaboration revision must be exact command snapshot';
  END IF;
  NEW.occurred_at := command.occurred_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_collaboration_revision_guard
BEFORE INSERT ON portfolio_collaboration_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_collaboration_revision();

CREATE OR REPLACE FUNCTION ensure_portfolio_collaboration_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM portfolio_collaborations current
    JOIN portfolio_collaboration_revisions revision
      ON revision.collaboration_id = current.id
     AND revision.command_id = NEW.command_id
     AND revision.revision = NEW.resulting_revision
    WHERE current.id = NEW.collaboration_id
      AND current.latest_command_id = NEW.command_id
      AND current.revision = NEW.resulting_revision
  ) THEN
    RAISE EXCEPTION 'portfolio collaboration command requires exact head and revision effects';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER portfolio_collaboration_command_effect_required
AFTER INSERT ON portfolio_collaboration_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_portfolio_collaboration_command_effect();

CREATE OR REPLACE FUNCTION ensure_portfolio_collaboration_initial_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM portfolio_collaboration_commands command
    WHERE command.command_id = NEW.latest_command_id
      AND command.collaboration_id = NEW.id
      AND command.command_kind = 'INVITE'
  ) THEN
    RAISE EXCEPTION 'portfolio collaboration requires invite command provenance';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER portfolio_collaboration_initial_command_required
AFTER INSERT ON portfolio_collaborations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_portfolio_collaboration_initial_command();

CREATE OR REPLACE FUNCTION reject_portfolio_collaboration_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'portfolio collaboration history is append-only';
END;
$$;
CREATE TRIGGER portfolio_collaborations_no_delete
BEFORE DELETE ON portfolio_collaborations
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_collaboration_history_mutation();
CREATE TRIGGER portfolio_collaboration_commands_immutable
BEFORE UPDATE OR DELETE ON portfolio_collaboration_commands
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_collaboration_history_mutation();
CREATE TRIGGER portfolio_collaboration_revisions_immutable
BEFORE UPDATE OR DELETE ON portfolio_collaboration_revisions
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_collaboration_history_mutation();

CREATE VIEW current_portfolio_collaboration_candidates AS
SELECT collaboration.portfolio_project_id AS project_id,
  collaboration.collaborator_profile_id,
  collaboration.role,
  collaboration.contribution,
  collaboration.accepted_at
FROM portfolio_collaborations collaboration
JOIN current_craftsman_profile_publications author_publication
  ON author_publication.craftsman_profile_id = collaboration.author_profile_id
 AND author_publication.effectively_public
JOIN current_craftsman_profile_publications collaborator_publication
  ON collaborator_publication.craftsman_profile_id = collaboration.collaborator_profile_id
 AND collaborator_publication.effectively_public
WHERE collaboration.state = 'ACCEPTED'
  AND collaboration.visibility = 'VISIBLE';

COMMENT ON VIEW current_portfolio_collaboration_candidates IS
  'Privacy-minimized accepted collaborator attribution candidates only, not complete public eligibility. This view never makes a PortfolioProject public; R1-018/R1-011 final projection must independently intersect project publication, moderation, consent and media eligibility.';
COMMENT ON TABLE portfolio_collaboration_revisions IS
  'Immutable invitation, confirmation and visibility history. Off-platform attribution never represents JobParticipant or verified Job provenance.';
