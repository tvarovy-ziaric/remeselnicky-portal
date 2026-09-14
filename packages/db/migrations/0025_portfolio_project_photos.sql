CREATE TYPE portfolio_photo_phase AS ENUM ('BEFORE', 'PROGRESS', 'AFTER', 'OTHER');
CREATE TYPE portfolio_photo_state AS ENUM ('ACTIVE', 'HIDDEN');
CREATE TYPE portfolio_photo_command_kind AS ENUM (
  'ATTACH', 'REORDER', 'SET_PHASE', 'HIDE', 'RESTORE'
);

CREATE TABLE portfolio_project_photo_sets (
  portfolio_project_id uuid PRIMARY KEY
    REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  latest_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (portfolio_project_id, craftsman_profile_id),
  CONSTRAINT portfolio_photo_sets_initial_shape CHECK (
    (revision = 0 AND latest_command_id IS NULL)
    OR (revision > 0 AND latest_command_id IS NOT NULL)
  ),
  CONSTRAINT portfolio_photo_sets_timestamps_ordered CHECK (updated_at >= created_at)
);

INSERT INTO portfolio_project_photo_sets (portfolio_project_id, craftsman_profile_id)
SELECT id, craftsman_profile_id FROM portfolio_projects;

CREATE FUNCTION initialize_portfolio_project_photo_set()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO portfolio_project_photo_sets (
    portfolio_project_id, craftsman_profile_id, created_at, updated_at
  ) VALUES (NEW.id, NEW.craftsman_profile_id, NEW.created_at, NEW.created_at);
  RETURN NULL;
END;
$$;
CREATE TRIGGER portfolio_project_photo_set_initialize
AFTER INSERT ON portfolio_projects
FOR EACH ROW EXECUTE FUNCTION initialize_portfolio_project_photo_set();

CREATE TABLE portfolio_photo_commands (
  command_id uuid PRIMARY KEY,
  command_kind portfolio_photo_command_kind NOT NULL,
  portfolio_project_id uuid NOT NULL,
  craftsman_profile_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  resulting_revision integer NOT NULL,
  target_attachment_id uuid,
  target_media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  target_phase portfolio_photo_phase,
  ordered_attachment_ids uuid[],
  payload_fingerprint char(64) NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (portfolio_project_id, craftsman_profile_id)
    REFERENCES portfolio_project_photo_sets(portfolio_project_id, craftsman_profile_id)
    ON DELETE RESTRICT,
  CONSTRAINT portfolio_photo_commands_revision_step CHECK (
    resulting_revision = expected_revision + 1
  ),
  CONSTRAINT portfolio_photo_commands_shape CHECK (
    (command_kind = 'ATTACH'
      AND target_attachment_id IS NOT NULL
      AND target_media_asset_id IS NOT NULL
      AND target_phase IS NOT NULL
      AND ordered_attachment_ids IS NULL)
    OR (command_kind = 'REORDER'
      AND target_attachment_id IS NULL
      AND target_media_asset_id IS NULL
      AND target_phase IS NULL
      AND portfolio_uuid_array_valid(ordered_attachment_ids, 0, 15))
    OR (command_kind = 'SET_PHASE'
      AND target_attachment_id IS NOT NULL
      AND target_media_asset_id IS NULL
      AND target_phase IS NOT NULL
      AND ordered_attachment_ids IS NULL)
    OR (command_kind IN ('HIDE', 'RESTORE')
      AND target_attachment_id IS NOT NULL
      AND target_media_asset_id IS NULL
      AND target_phase IS NULL
      AND ordered_attachment_ids IS NULL)
  )
);

ALTER TABLE portfolio_project_photo_sets
ADD CONSTRAINT portfolio_photo_sets_latest_command_fkey
FOREIGN KEY (latest_command_id) REFERENCES portfolio_photo_commands(command_id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE portfolio_photo_attachments (
  id uuid PRIMARY KEY,
  portfolio_project_id uuid NOT NULL
    REFERENCES portfolio_project_photo_sets(portfolio_project_id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL UNIQUE
    REFERENCES media_assets(id) ON DELETE RESTRICT,
  attached_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attach_command_id uuid NOT NULL UNIQUE
    REFERENCES portfolio_photo_commands(command_id) ON DELETE RESTRICT,
  attached_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE portfolio_photo_commands
ADD CONSTRAINT portfolio_photo_commands_target_attachment_fkey
FOREIGN KEY (target_attachment_id) REFERENCES portfolio_photo_attachments(id)
ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE portfolio_photo_revisions (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE
    REFERENCES portfolio_photo_commands(command_id) ON DELETE RESTRICT,
  portfolio_project_id uuid NOT NULL
    REFERENCES portfolio_project_photo_sets(portfolio_project_id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_transaction_id bigint NOT NULL DEFAULT txid_current(),
  UNIQUE (portfolio_project_id, revision)
);

CREATE TABLE portfolio_photo_revision_items (
  revision_event_id uuid NOT NULL
    REFERENCES portfolio_photo_revisions(event_id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL
    REFERENCES portfolio_photo_attachments(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  state portfolio_photo_state NOT NULL,
  phase portfolio_photo_phase NOT NULL,
  display_order integer,
  captured_at timestamptz,
  canonical_width integer NOT NULL CHECK (canonical_width BETWEEN 1 AND 2560),
  canonical_height integer NOT NULL CHECK (canonical_height BETWEEN 1 AND 2560),
  created_transaction_id bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (revision_event_id, attachment_id),
  UNIQUE (revision_event_id, display_order),
  CONSTRAINT portfolio_photo_revision_item_state_order CHECK (
    (state = 'ACTIVE' AND display_order BETWEEN 1 AND 15)
    OR (state = 'HIDDEN' AND display_order IS NULL)
  )
);

CREATE INDEX portfolio_photo_revisions_project_idx
ON portfolio_photo_revisions (portfolio_project_id, revision DESC);
CREATE INDEX portfolio_photo_revision_items_attachment_idx
ON portfolio_photo_revision_items (attachment_id, revision_event_id);

CREATE FUNCTION enforce_portfolio_photo_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE photo_set portfolio_project_photo_sets%ROWTYPE;
DECLARE project portfolio_projects%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  PERFORM lock_active_portfolio_owner(NEW.craftsman_profile_id, NEW.actor_user_id);
  SELECT * INTO project FROM portfolio_projects
  WHERE id = NEW.portfolio_project_id FOR UPDATE;
  SELECT * INTO photo_set FROM portfolio_project_photo_sets
  WHERE portfolio_project_id = NEW.portfolio_project_id FOR UPDATE;
  IF photo_set.portfolio_project_id IS NULL OR project.id IS NULL
    OR photo_set.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR project.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR project.author_user_id IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'owned portfolio photo set required';
  END IF;
  IF project.record_state = 'ARCHIVED' THEN
    RAISE EXCEPTION 'archived portfolio project photos are immutable';
  END IF;
  IF photo_set.revision IS DISTINCT FROM NEW.expected_revision
    OR NEW.resulting_revision IS DISTINCT FROM photo_set.revision + 1 THEN
    RAISE EXCEPTION 'stale portfolio photo revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_photo_command_guard
BEFORE INSERT ON portfolio_photo_commands
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_photo_command();

CREATE FUNCTION enforce_portfolio_photo_attachment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command portfolio_photo_commands%ROWTYPE;
DECLARE asset media_assets%ROWTYPE;
BEGIN
  SELECT * INTO command FROM portfolio_photo_commands
  WHERE command_id = NEW.attach_command_id;
  SELECT * INTO asset FROM media_assets WHERE id = NEW.media_asset_id FOR UPDATE;
  IF command.command_id IS NULL OR command.command_kind <> 'ATTACH'
    OR command.portfolio_project_id IS DISTINCT FROM NEW.portfolio_project_id
    OR command.actor_user_id IS DISTINCT FROM NEW.attached_by_user_id
    OR command.target_attachment_id IS DISTINCT FROM NEW.id
    OR command.target_media_asset_id IS DISTINCT FROM NEW.media_asset_id THEN
    RAISE EXCEPTION 'portfolio photo attachment requires matching command provenance';
  END IF;
  IF asset.id IS NULL OR asset.owner_user_id IS DISTINCT FROM command.actor_user_id
    OR asset.uploaded_by_user_id IS DISTINCT FROM command.actor_user_id
    OR asset.kind <> 'IMAGE' OR asset.purpose <> 'PORTFOLIO_IMAGE'
    OR asset.status <> 'READY'
    OR asset.provenance_entity_type <> 'PORTFOLIO_PROJECT'
    OR asset.provenance_entity_id IS DISTINCT FROM NEW.portfolio_project_id
    OR asset.provenance_entity_revision IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM portfolio_project_revisions revision
      WHERE revision.portfolio_project_id = NEW.portfolio_project_id
        AND revision.revision = asset.provenance_entity_revision
    ) THEN
    RAISE EXCEPTION 'ready canonical owned portfolio image with exact provenance required';
  END IF;
  PERFORM 1 FROM media_asset_storage_objects object
  WHERE object.media_asset_id = asset.id AND object.role = 'CANONICAL'
    AND object.storage_area = 'private' AND object.revoked_at IS NULL
    AND object.content_type = 'image/webp'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ready canonical owned portfolio image with exact provenance required';
  END IF;
  NEW.attached_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_photo_attachment_guard
BEFORE INSERT ON portfolio_photo_attachments
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_photo_attachment();

CREATE FUNCTION enforce_portfolio_photo_set_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command portfolio_photo_commands%ROWTYPE;
BEGIN
  IF NEW.portfolio_project_id IS DISTINCT FROM OLD.portfolio_project_id
    OR NEW.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'portfolio photo set identity is immutable';
  END IF;
  SELECT * INTO command FROM portfolio_photo_commands
  WHERE command_id = NEW.latest_command_id;
  IF command.command_id IS NULL
    OR command.portfolio_project_id IS DISTINCT FROM OLD.portfolio_project_id
    OR command.craftsman_profile_id IS DISTINCT FROM OLD.craftsman_profile_id
    OR command.expected_revision IS DISTINCT FROM OLD.revision
    OR command.resulting_revision IS DISTINCT FROM NEW.revision
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
    RAISE EXCEPTION 'portfolio photo set update requires matching command';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_photo_set_update_guard
BEFORE UPDATE ON portfolio_project_photo_sets
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_photo_set_update();

CREATE FUNCTION enforce_portfolio_photo_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE photo_set portfolio_project_photo_sets%ROWTYPE;
DECLARE command portfolio_photo_commands%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  NEW.created_transaction_id := txid_current();
  SELECT * INTO photo_set FROM portfolio_project_photo_sets
  WHERE portfolio_project_id = NEW.portfolio_project_id FOR UPDATE;
  SELECT * INTO command FROM portfolio_photo_commands WHERE command_id = NEW.command_id;
  IF photo_set.portfolio_project_id IS NULL OR command.command_id IS NULL
    OR photo_set.latest_command_id IS DISTINCT FROM command.command_id
    OR photo_set.revision IS DISTINCT FROM NEW.revision
    OR command.resulting_revision IS DISTINCT FROM NEW.revision
    OR command.portfolio_project_id IS DISTINCT FROM NEW.portfolio_project_id
    OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'portfolio photo revision requires exact command effect';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_photo_revision_guard
BEFORE INSERT ON portfolio_photo_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_photo_revision();

CREATE FUNCTION enforce_portfolio_photo_revision_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_transaction_id bigint;
BEGIN
  SELECT created_transaction_id INTO parent_transaction_id
  FROM portfolio_photo_revisions
  WHERE event_id = NEW.revision_event_id;
  IF parent_transaction_id IS NULL OR parent_transaction_id <> txid_current() THEN
    RAISE EXCEPTION 'portfolio photo revision items must be sealed with their parent revision';
  END IF;
  NEW.created_transaction_id := txid_current();
  RETURN NEW;
END;
$$;
CREATE TRIGGER portfolio_photo_revision_item_insert_guard
BEFORE INSERT ON portfolio_photo_revision_items
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_photo_revision_item_insert();

CREATE FUNCTION ensure_portfolio_photo_command_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate_event_id uuid;
DECLARE previous_event_id uuid;
DECLARE new_count integer;
DECLARE prior_count integer;
DECLARE active_count integer;
DECLARE target_prior portfolio_photo_revision_items%ROWTYPE;
BEGIN
  SELECT event_id INTO candidate_event_id FROM portfolio_photo_revisions
  WHERE command_id = NEW.command_id
    AND portfolio_project_id = NEW.portfolio_project_id
    AND revision = NEW.resulting_revision;
  IF candidate_event_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM portfolio_project_photo_sets photo_set
    WHERE photo_set.portfolio_project_id = NEW.portfolio_project_id
      AND photo_set.latest_command_id = NEW.command_id
      AND photo_set.revision = NEW.resulting_revision
  ) THEN
    RAISE EXCEPTION 'portfolio photo command requires exact set and revision effects';
  END IF;
  IF NEW.expected_revision > 0 THEN
    SELECT event_id INTO previous_event_id FROM portfolio_photo_revisions
    WHERE portfolio_project_id = NEW.portfolio_project_id
      AND revision = NEW.expected_revision;
    IF previous_event_id IS NULL THEN
      RAISE EXCEPTION 'portfolio photo command prior revision is missing';
    END IF;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE state = 'ACTIVE')
    INTO new_count, active_count
  FROM portfolio_photo_revision_items WHERE revision_event_id = candidate_event_id;
  SELECT count(*) INTO prior_count FROM portfolio_photo_revision_items
  WHERE revision_event_id = previous_event_id;
  IF active_count > 15
    OR active_count <> (
      SELECT count(DISTINCT display_order) FROM portfolio_photo_revision_items
      WHERE revision_event_id = candidate_event_id AND state = 'ACTIVE'
    )
    OR (active_count > 0 AND (
      SELECT min(display_order) FROM portfolio_photo_revision_items
      WHERE revision_event_id = candidate_event_id AND state = 'ACTIVE'
    ) <> 1)
    OR (active_count > 0 AND (
      SELECT max(display_order) FROM portfolio_photo_revision_items
      WHERE revision_event_id = candidate_event_id AND state = 'ACTIVE'
    ) <> active_count)
    OR new_count <> (
      SELECT count(*) FROM portfolio_photo_attachments attachment
      WHERE attachment.portfolio_project_id = NEW.portfolio_project_id
    )
    OR EXISTS (
      SELECT 1 FROM portfolio_photo_revision_items item
      JOIN portfolio_photo_attachments attachment ON attachment.id = item.attachment_id
      WHERE item.revision_event_id = candidate_event_id
        AND (attachment.portfolio_project_id IS DISTINCT FROM NEW.portfolio_project_id
          OR attachment.media_asset_id IS DISTINCT FROM item.media_asset_id)
    ) THEN
    RAISE EXCEPTION 'portfolio photo snapshot is incomplete or exceeds max 15 active photos';
  END IF;

  IF NEW.command_kind = 'ATTACH' THEN
    IF new_count <> prior_count + 1 OR NOT EXISTS (
      SELECT 1 FROM portfolio_photo_revision_items item
      WHERE item.revision_event_id = candidate_event_id
        AND item.attachment_id = NEW.target_attachment_id
        AND item.media_asset_id = NEW.target_media_asset_id
        AND item.state = 'ACTIVE' AND item.phase = NEW.target_phase
        AND item.display_order = active_count
    ) OR NOT EXISTS (
      SELECT 1 FROM portfolio_photo_revision_items item
      JOIN media_assets asset ON asset.id = item.media_asset_id
      WHERE item.revision_event_id = candidate_event_id
        AND item.attachment_id = NEW.target_attachment_id
        AND item.media_asset_id = NEW.target_media_asset_id
        AND item.captured_at IS NOT DISTINCT FROM asset.captured_at
        AND item.canonical_width IS NOT DISTINCT FROM asset.canonical_width
        AND item.canonical_height IS NOT DISTINCT FROM asset.canonical_height
    ) OR EXISTS (
      SELECT 1 FROM portfolio_photo_revision_items old_item
      LEFT JOIN portfolio_photo_revision_items new_item
        ON new_item.revision_event_id = candidate_event_id
        AND new_item.attachment_id = old_item.attachment_id
      WHERE old_item.revision_event_id = previous_event_id
        AND ROW(new_item.media_asset_id, new_item.state, new_item.phase,
          new_item.display_order, new_item.captured_at,
          new_item.canonical_width, new_item.canonical_height)
          IS DISTINCT FROM ROW(old_item.media_asset_id, old_item.state,
          old_item.phase, old_item.display_order, old_item.captured_at,
          old_item.canonical_width, old_item.canonical_height)
    ) THEN RAISE EXCEPTION 'invalid portfolio photo attach effect'; END IF;
  ELSE
    SELECT * INTO target_prior FROM portfolio_photo_revision_items
    WHERE revision_event_id = previous_event_id
      AND attachment_id = NEW.target_attachment_id;
    IF new_count <> prior_count THEN
      RAISE EXCEPTION 'portfolio photo command cannot add or drop attachment history';
    END IF;
    IF NEW.command_kind = 'HIDE' THEN
      IF target_prior.attachment_id IS NULL OR target_prior.state <> 'ACTIVE'
        OR EXISTS (
          SELECT 1 FROM portfolio_photo_revision_items old_item
          LEFT JOIN portfolio_photo_revision_items new_item
            ON new_item.revision_event_id = candidate_event_id
            AND new_item.attachment_id = old_item.attachment_id
          WHERE old_item.revision_event_id = previous_event_id AND (
            new_item.attachment_id IS NULL
            OR new_item.media_asset_id IS DISTINCT FROM old_item.media_asset_id
            OR new_item.phase IS DISTINCT FROM old_item.phase
            OR new_item.captured_at IS DISTINCT FROM old_item.captured_at
            OR new_item.canonical_width IS DISTINCT FROM old_item.canonical_width
            OR new_item.canonical_height IS DISTINCT FROM old_item.canonical_height
            OR CASE WHEN old_item.attachment_id = NEW.target_attachment_id
              THEN new_item.state <> 'HIDDEN' OR new_item.display_order IS NOT NULL
              ELSE new_item.state IS DISTINCT FROM old_item.state
                OR new_item.display_order IS DISTINCT FROM
                  CASE WHEN old_item.state = 'ACTIVE'
                    AND old_item.display_order > target_prior.display_order
                    THEN old_item.display_order - 1 ELSE old_item.display_order END
              END)
        ) THEN RAISE EXCEPTION 'invalid portfolio photo hide effect'; END IF;
    ELSIF NEW.command_kind = 'RESTORE' THEN
      IF target_prior.attachment_id IS NULL OR target_prior.state <> 'HIDDEN'
        OR EXISTS (
          SELECT 1 FROM portfolio_photo_revision_items old_item
          LEFT JOIN portfolio_photo_revision_items new_item
            ON new_item.revision_event_id = candidate_event_id
            AND new_item.attachment_id = old_item.attachment_id
          WHERE old_item.revision_event_id = previous_event_id AND (
            new_item.media_asset_id IS DISTINCT FROM old_item.media_asset_id
            OR new_item.phase IS DISTINCT FROM old_item.phase
            OR new_item.captured_at IS DISTINCT FROM old_item.captured_at
            OR new_item.canonical_width IS DISTINCT FROM old_item.canonical_width
            OR new_item.canonical_height IS DISTINCT FROM old_item.canonical_height
            OR CASE WHEN old_item.attachment_id = NEW.target_attachment_id
              THEN new_item.state <> 'ACTIVE' OR new_item.display_order <> active_count
              ELSE new_item.state IS DISTINCT FROM old_item.state
                OR new_item.display_order IS DISTINCT FROM old_item.display_order END)
        ) THEN RAISE EXCEPTION 'invalid portfolio photo restore effect'; END IF;
    ELSIF NEW.command_kind = 'SET_PHASE' THEN
      IF target_prior.attachment_id IS NULL OR target_prior.phase = NEW.target_phase
        OR EXISTS (
          SELECT 1 FROM portfolio_photo_revision_items old_item
          LEFT JOIN portfolio_photo_revision_items new_item
            ON new_item.revision_event_id = candidate_event_id
            AND new_item.attachment_id = old_item.attachment_id
          WHERE old_item.revision_event_id = previous_event_id AND (
            ROW(new_item.media_asset_id, new_item.state, new_item.display_order,
              new_item.captured_at, new_item.canonical_width, new_item.canonical_height)
              IS DISTINCT FROM ROW(old_item.media_asset_id, old_item.state,
              old_item.display_order, old_item.captured_at,
              old_item.canonical_width, old_item.canonical_height)
            OR new_item.phase IS DISTINCT FROM CASE
              WHEN old_item.attachment_id = NEW.target_attachment_id
                THEN NEW.target_phase ELSE old_item.phase END)
        ) THEN RAISE EXCEPTION 'invalid portfolio photo phase effect'; END IF;
    ELSIF NEW.command_kind = 'REORDER' THEN
      IF cardinality(NEW.ordered_attachment_ids) <> active_count
        OR EXISTS (
          SELECT 1 FROM portfolio_photo_revision_items old_item
          LEFT JOIN portfolio_photo_revision_items new_item
            ON new_item.revision_event_id = candidate_event_id
            AND new_item.attachment_id = old_item.attachment_id
          WHERE old_item.revision_event_id = previous_event_id AND (
            ROW(new_item.media_asset_id, new_item.state, new_item.phase,
              new_item.captured_at, new_item.canonical_width, new_item.canonical_height)
              IS DISTINCT FROM ROW(old_item.media_asset_id, old_item.state,
              old_item.phase, old_item.captured_at,
              old_item.canonical_width, old_item.canonical_height)
            OR new_item.display_order IS DISTINCT FROM CASE
              WHEN old_item.state = 'ACTIVE'
                THEN array_position(NEW.ordered_attachment_ids, old_item.attachment_id)
              ELSE NULL END)
        ) THEN RAISE EXCEPTION 'invalid portfolio photo reorder effect'; END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER portfolio_photo_command_effect_required
AFTER INSERT ON portfolio_photo_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_portfolio_photo_command_effect();

CREATE FUNCTION reject_portfolio_photo_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'portfolio photo history is append-only'; END;
$$;
CREATE TRIGGER portfolio_photo_sets_no_delete
BEFORE DELETE ON portfolio_project_photo_sets
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_photo_history_mutation();
CREATE TRIGGER portfolio_photo_attachments_immutable
BEFORE UPDATE OR DELETE ON portfolio_photo_attachments
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_photo_history_mutation();
CREATE TRIGGER portfolio_photo_commands_immutable
BEFORE UPDATE OR DELETE ON portfolio_photo_commands
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_photo_history_mutation();
CREATE TRIGGER portfolio_photo_revisions_immutable
BEFORE UPDATE OR DELETE ON portfolio_photo_revisions
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_photo_history_mutation();
CREATE TRIGGER portfolio_photo_revision_items_immutable
BEFORE UPDATE OR DELETE ON portfolio_photo_revision_items
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_photo_history_mutation();

CREATE VIEW current_portfolio_project_photos AS
SELECT photo_set.portfolio_project_id, photo_set.craftsman_profile_id,
  photo_set.revision, photo_set.updated_at,
  item.attachment_id, item.media_asset_id, item.state, item.phase,
  item.display_order, item.captured_at, item.canonical_width,
  item.canonical_height, attachment.attached_at
FROM portfolio_project_photo_sets photo_set
LEFT JOIN portfolio_photo_revisions revision
  ON revision.portfolio_project_id = photo_set.portfolio_project_id
  AND revision.revision = photo_set.revision
LEFT JOIN portfolio_photo_revision_items item
  ON item.revision_event_id = revision.event_id
LEFT JOIN portfolio_photo_attachments attachment
  ON attachment.id = item.attachment_id;

COMMENT ON VIEW current_portfolio_project_photos IS
  'Private R1-014 owner projection. Contains no storage key, filename, public derivative, consent, customer identity or verified Job claim.';
