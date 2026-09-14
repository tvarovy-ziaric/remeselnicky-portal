CREATE TYPE portfolio_project_publication_state AS ENUM ('HIDDEN', 'PUBLIC');
CREATE TYPE portfolio_project_publication_command_kind AS ENUM ('PUBLISH', 'HIDE');

ALTER TABLE media_asset_storage_objects
  ADD COLUMN public_url text;

ALTER TABLE media_asset_storage_objects
  DROP CONSTRAINT media_asset_storage_objects_role_unique;

CREATE UNIQUE INDEX media_asset_storage_objects_live_role_unique
  ON media_asset_storage_objects (media_asset_id, role)
  WHERE revoked_at IS NULL;

ALTER TABLE media_asset_storage_objects
  ADD CONSTRAINT media_asset_storage_objects_public_url_consistent CHECK (
    (storage_area = 'private' AND public_url IS NULL)
    OR (
      storage_area = 'public-derivative'
      AND public_url IS NOT NULL
      AND length(public_url) BETWEEN 12 AND 2048
      AND public_url ~ '^https://[^/?#@[:space:]]+(/[^?#@[:space:]]*)?$'
    )
  );

CREATE TABLE portfolio_project_publications (
  portfolio_project_id uuid PRIMARY KEY
    REFERENCES portfolio_projects(id) ON DELETE RESTRICT,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state portfolio_project_publication_state NOT NULL DEFAULT 'HIDDEN',
  latest_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (portfolio_project_id, craftsman_profile_id),
  CONSTRAINT portfolio_project_publications_initial_shape CHECK (
    (revision = 0 AND state = 'HIDDEN' AND latest_command_id IS NULL)
    OR (revision > 0 AND latest_command_id IS NOT NULL)
  ),
  CONSTRAINT portfolio_project_publications_timestamps_ordered
    CHECK (updated_at >= created_at)
);

INSERT INTO portfolio_project_publications (
  portfolio_project_id, craftsman_profile_id, created_at, updated_at
)
SELECT id, craftsman_profile_id, created_at, created_at
FROM portfolio_projects;

CREATE FUNCTION initialize_portfolio_project_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO portfolio_project_publications (
    portfolio_project_id, craftsman_profile_id, created_at, updated_at
  ) VALUES (NEW.id, NEW.craftsman_profile_id, NEW.created_at, NEW.created_at);
  RETURN NULL;
END;
$$;

CREATE TRIGGER portfolio_project_publication_initialize
AFTER INSERT ON portfolio_projects
FOR EACH ROW EXECUTE FUNCTION initialize_portfolio_project_publication();

CREATE TABLE portfolio_project_publication_commands (
  command_id uuid PRIMARY KEY,
  command_kind portfolio_project_publication_command_kind NOT NULL,
  portfolio_project_id uuid NOT NULL,
  craftsman_profile_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  resulting_revision integer NOT NULL CHECK (resulting_revision > 0),
  project_revision integer NOT NULL CHECK (project_revision > 0),
  photo_set_revision integer NOT NULL CHECK (photo_set_revision > 0),
  resulting_state portfolio_project_publication_state NOT NULL,
  payload_fingerprint character(64) NOT NULL
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (portfolio_project_id, craftsman_profile_id)
    REFERENCES portfolio_project_publications (
      portfolio_project_id, craftsman_profile_id
    ) ON DELETE RESTRICT,
  CONSTRAINT portfolio_project_publication_commands_revision_step
    CHECK (resulting_revision = expected_revision + 1),
  CONSTRAINT portfolio_project_publication_commands_state_shape CHECK (
    (command_kind = 'PUBLISH' AND resulting_state = 'PUBLIC')
    OR (command_kind = 'HIDE' AND resulting_state = 'HIDDEN')
  )
);

ALTER TABLE portfolio_project_publications
  ADD CONSTRAINT portfolio_project_publications_latest_command_fkey
  FOREIGN KEY (latest_command_id)
  REFERENCES portfolio_project_publication_commands(command_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE portfolio_project_publication_revisions (
  event_id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE
    REFERENCES portfolio_project_publication_commands(command_id)
    ON DELETE RESTRICT,
  portfolio_project_id uuid NOT NULL
    REFERENCES portfolio_project_publications(portfolio_project_id)
    ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  state portfolio_project_publication_state NOT NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  photo_set_revision integer NOT NULL CHECK (photo_set_revision > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_transaction_id bigint NOT NULL DEFAULT txid_current(),
  UNIQUE (portfolio_project_id, revision)
);

CREATE TABLE portfolio_project_publication_items (
  revision_event_id uuid NOT NULL
    REFERENCES portfolio_project_publication_revisions(event_id)
    ON DELETE RESTRICT,
  attachment_id uuid NOT NULL
    REFERENCES portfolio_photo_attachments(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL
    REFERENCES media_assets(id) ON DELETE RESTRICT,
  source_object_id uuid NOT NULL
    REFERENCES media_asset_storage_objects(id) ON DELETE RESTRICT,
  public_object_id uuid NOT NULL UNIQUE
    REFERENCES media_asset_storage_objects(id) ON DELETE RESTRICT,
  phase portfolio_photo_phase NOT NULL,
  display_order integer NOT NULL CHECK (display_order BETWEEN 1 AND 15),
  canonical_width integer NOT NULL CHECK (canonical_width BETWEEN 1 AND 2560),
  canonical_height integer NOT NULL CHECK (canonical_height BETWEEN 1 AND 2560),
  created_transaction_id bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (revision_event_id, attachment_id),
  UNIQUE (revision_event_id, media_asset_id),
  UNIQUE (revision_event_id, display_order)
);

CREATE INDEX portfolio_project_publication_revisions_project_idx
  ON portfolio_project_publication_revisions (portfolio_project_id, revision DESC);
CREATE INDEX portfolio_project_publication_items_asset_idx
  ON portfolio_project_publication_items (media_asset_id, revision_event_id);

CREATE FUNCTION enforce_portfolio_project_publication_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project portfolio_projects%ROWTYPE;
DECLARE photo_set portfolio_project_photo_sets%ROWTYPE;
DECLARE publication portfolio_project_publications%ROWTYPE;
DECLARE active_photo_count integer;
BEGIN
  NEW.occurred_at := clock_timestamp();
  PERFORM lock_active_portfolio_owner(
    NEW.craftsman_profile_id,
    NEW.actor_user_id
  );

  SELECT * INTO project
  FROM portfolio_projects
  WHERE id = NEW.portfolio_project_id
  FOR UPDATE;

  SELECT * INTO photo_set
  FROM portfolio_project_photo_sets
  WHERE portfolio_project_id = NEW.portfolio_project_id
  FOR UPDATE;

  SELECT * INTO publication
  FROM portfolio_project_publications
  WHERE portfolio_project_id = NEW.portfolio_project_id
  FOR UPDATE;

  IF project.id IS NULL OR photo_set.portfolio_project_id IS NULL
    OR publication.portfolio_project_id IS NULL
    OR project.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR project.author_user_id IS DISTINCT FROM NEW.actor_user_id
    OR photo_set.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id
    OR publication.craftsman_profile_id IS DISTINCT FROM NEW.craftsman_profile_id THEN
    RAISE EXCEPTION 'owned portfolio publication required';
  END IF;

  IF publication.revision IS DISTINCT FROM NEW.expected_revision
    OR NEW.resulting_revision IS DISTINCT FROM publication.revision + 1 THEN
    RAISE EXCEPTION 'stale portfolio publication revision';
  END IF;

  IF project.revision IS DISTINCT FROM NEW.project_revision
    OR photo_set.revision IS DISTINCT FROM NEW.photo_set_revision THEN
    RAISE EXCEPTION 'stale portfolio publication source revision';
  END IF;

  IF NEW.command_kind = 'PUBLISH' THEN
    IF project.record_state <> 'DRAFT'
      OR project.provenance_kind <> 'SELF_DECLARED' THEN
      RAISE EXCEPTION 'portfolio project is not publication eligible';
    END IF;

    SELECT count(*)::integer INTO active_photo_count
    FROM portfolio_photo_revisions photo_revision
    JOIN portfolio_photo_revision_items photo
      ON photo.revision_event_id = photo_revision.event_id
    JOIN portfolio_photo_attachments attachment
      ON attachment.id = photo.attachment_id
    JOIN media_assets asset
      ON asset.id = photo.media_asset_id
    JOIN media_asset_storage_objects source
      ON source.media_asset_id = asset.id
      AND source.role = 'THUMBNAIL'
      AND source.storage_area = 'private'
      AND source.revoked_at IS NULL
    WHERE photo_revision.portfolio_project_id = NEW.portfolio_project_id
      AND photo_revision.revision = NEW.photo_set_revision
      AND photo.state = 'ACTIVE'
      AND asset.status = 'READY'
      AND asset.kind = 'IMAGE'
      AND asset.purpose = 'PORTFOLIO_IMAGE'
      AND asset.owner_user_id = NEW.actor_user_id
      AND asset.provenance_entity_type = 'PORTFOLIO_PROJECT'
      AND asset.provenance_entity_id = NEW.portfolio_project_id
      AND source.content_type = 'image/webp'
      AND source.content_sha256 IS NOT NULL;

    IF active_photo_count < 1 OR active_photo_count > 15 THEN
      RAISE EXCEPTION 'public portfolio project requires current safe photos';
    END IF;
  ELSIF publication.state <> 'PUBLIC' THEN
    RAISE EXCEPTION 'portfolio publication is already hidden';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER portfolio_project_publication_command_guard
BEFORE INSERT ON portfolio_project_publication_commands
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_publication_command();

CREATE FUNCTION enforce_portfolio_project_publication_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command portfolio_project_publication_commands%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  NEW.created_transaction_id := txid_current();
  SELECT * INTO command
  FROM portfolio_project_publication_commands
  WHERE command_id = NEW.command_id;
  IF command.command_id IS NULL
    OR command.portfolio_project_id IS DISTINCT FROM NEW.portfolio_project_id
    OR command.resulting_revision IS DISTINCT FROM NEW.revision
    OR command.resulting_state IS DISTINCT FROM NEW.state
    OR command.project_revision IS DISTINCT FROM NEW.project_revision
    OR command.photo_set_revision IS DISTINCT FROM NEW.photo_set_revision
    OR command.actor_user_id IS DISTINCT FROM NEW.actor_user_id THEN
    RAISE EXCEPTION 'portfolio publication revision must match its command';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portfolio_project_publication_revision_guard
BEFORE INSERT ON portfolio_project_publication_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_publication_revision();

CREATE FUNCTION enforce_portfolio_project_publication_item()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication_revision portfolio_project_publication_revisions%ROWTYPE;
DECLARE command portfolio_project_publication_commands%ROWTYPE;
DECLARE photo record;
DECLARE source media_asset_storage_objects%ROWTYPE;
DECLARE public_object media_asset_storage_objects%ROWTYPE;
BEGIN
  NEW.created_transaction_id := txid_current();
  SELECT * INTO publication_revision
  FROM portfolio_project_publication_revisions
  WHERE event_id = NEW.revision_event_id;
  SELECT * INTO command
  FROM portfolio_project_publication_commands
  WHERE command_id = publication_revision.command_id;

  IF publication_revision.event_id IS NULL
    OR publication_revision.created_transaction_id <> txid_current()
    OR command.command_kind <> 'PUBLISH' THEN
    RAISE EXCEPTION 'portfolio publication items must be transaction-sealed';
  END IF;

  SELECT item.attachment_id, item.media_asset_id, item.phase,
    item.display_order, item.canonical_width, item.canonical_height
  INTO photo
  FROM portfolio_photo_revisions photo_revision
  JOIN portfolio_photo_revision_items item
    ON item.revision_event_id = photo_revision.event_id
  WHERE photo_revision.portfolio_project_id = command.portfolio_project_id
    AND photo_revision.revision = command.photo_set_revision
    AND item.attachment_id = NEW.attachment_id
    AND item.state = 'ACTIVE';

  SELECT * INTO source
  FROM media_asset_storage_objects
  WHERE id = NEW.source_object_id
  FOR UPDATE;
  SELECT * INTO public_object
  FROM media_asset_storage_objects
  WHERE id = NEW.public_object_id
  FOR UPDATE;

  IF photo.attachment_id IS NULL
    OR photo.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR photo.phase IS DISTINCT FROM NEW.phase
    OR photo.display_order IS DISTINCT FROM NEW.display_order
    OR photo.canonical_width IS DISTINCT FROM NEW.canonical_width
    OR photo.canonical_height IS DISTINCT FROM NEW.canonical_height
    OR source.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR source.role <> 'THUMBNAIL'
    OR source.storage_area <> 'private'
    OR source.revoked_at IS NOT NULL
    OR source.content_type <> 'image/webp'
    OR source.content_sha256 IS NULL
    OR public_object.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR public_object.role <> 'DETAIL'
    OR public_object.storage_area <> 'public-derivative'
    OR public_object.revoked_at IS NOT NULL
    OR public_object.content_type <> 'image/webp'
    OR public_object.content_sha256 IS DISTINCT FROM source.content_sha256
    OR public_object.byte_size IS DISTINCT FROM source.byte_size
    OR public_object.public_url IS NULL THEN
    RAISE EXCEPTION 'exact safe public portfolio derivative required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portfolio_project_publication_item_guard
BEFORE INSERT ON portfolio_project_publication_items
FOR EACH ROW EXECUTE FUNCTION enforce_portfolio_project_publication_item();

CREATE FUNCTION ensure_portfolio_project_publication_effect()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate_revision_event_id uuid;
DECLARE publication portfolio_project_publications%ROWTYPE;
DECLARE expected_count integer;
DECLARE actual_count integer;
BEGIN
  SELECT * INTO publication
  FROM portfolio_project_publications
  WHERE portfolio_project_id = NEW.portfolio_project_id;
  SELECT event_id INTO candidate_revision_event_id
  FROM portfolio_project_publication_revisions
  WHERE command_id = NEW.command_id
    AND portfolio_project_id = NEW.portfolio_project_id
    AND revision = NEW.resulting_revision
    AND state = NEW.resulting_state
    AND project_revision = NEW.project_revision
    AND photo_set_revision = NEW.photo_set_revision;

  IF candidate_revision_event_id IS NULL
    OR publication.revision IS DISTINCT FROM NEW.resulting_revision
    OR publication.state IS DISTINCT FROM NEW.resulting_state
    OR publication.latest_command_id IS DISTINCT FROM NEW.command_id THEN
    RAISE EXCEPTION 'portfolio publication command requires exact effect';
  END IF;

  SELECT count(*)::integer INTO actual_count
  FROM portfolio_project_publication_items
  WHERE revision_event_id = candidate_revision_event_id;

  IF NEW.command_kind = 'PUBLISH' THEN
    SELECT count(*)::integer INTO expected_count
    FROM portfolio_photo_revisions photo_revision
    JOIN portfolio_photo_revision_items item
      ON item.revision_event_id = photo_revision.event_id
    WHERE photo_revision.portfolio_project_id = NEW.portfolio_project_id
      AND photo_revision.revision = NEW.photo_set_revision
      AND item.state = 'ACTIVE';
    IF actual_count IS DISTINCT FROM expected_count OR actual_count < 1 THEN
      RAISE EXCEPTION 'portfolio publication must include every current photo';
    END IF;
  ELSIF actual_count <> 0 THEN
    RAISE EXCEPTION 'hidden portfolio publication cannot expose photos';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER portfolio_project_publication_effect_required
AFTER INSERT ON portfolio_project_publication_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_portfolio_project_publication_effect();

CREATE FUNCTION ensure_public_portfolio_derivative_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_area = 'public-derivative'
    AND NEW.role = 'DETAIL'
    AND EXISTS (
      SELECT 1 FROM media_assets
      WHERE id = NEW.media_asset_id AND purpose = 'PORTFOLIO_IMAGE'
    )
    AND NOT EXISTS (
      SELECT 1 FROM portfolio_project_publication_items
      WHERE public_object_id = NEW.id
    ) THEN
    RAISE EXCEPTION 'public portfolio derivative requires publication provenance';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER public_portfolio_derivative_reference_required
AFTER INSERT ON media_asset_storage_objects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_public_portfolio_derivative_reference();

CREATE FUNCTION reject_portfolio_project_publication_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portfolio publication history is append-only';
END;
$$;

CREATE TRIGGER portfolio_project_publications_no_delete
BEFORE DELETE ON portfolio_project_publications
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_project_publication_history_mutation();
CREATE TRIGGER portfolio_project_publication_commands_append_only
BEFORE UPDATE OR DELETE ON portfolio_project_publication_commands
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_project_publication_history_mutation();
CREATE TRIGGER portfolio_project_publication_revisions_append_only
BEFORE UPDATE OR DELETE ON portfolio_project_publication_revisions
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_project_publication_history_mutation();
CREATE TRIGGER portfolio_project_publication_items_append_only
BEFORE UPDATE OR DELETE ON portfolio_project_publication_items
FOR EACH ROW EXECUTE FUNCTION reject_portfolio_project_publication_history_mutation();

CREATE FUNCTION guard_media_storage_object_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'media storage object identity is immutable';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR OLD.role IS DISTINCT FROM NEW.role
    OR OLD.storage_area IS DISTINCT FROM NEW.storage_area
    OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
    OR OLD.content_type IS DISTINCT FROM NEW.content_type
    OR OLD.byte_size IS DISTINCT FROM NEW.byte_size
    OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
    OR OLD.public_url IS DISTINCT FROM NEW.public_url
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'media storage object identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_storage_objects_immutable_except_revoke
BEFORE UPDATE OR DELETE ON media_asset_storage_objects
FOR EACH ROW EXECUTE FUNCTION guard_media_storage_object_mutation();

CREATE VIEW current_public_portfolio_projects AS
SELECT project.id AS portfolio_project_id,
  project.craftsman_profile_id,
  project.revision AS project_revision,
  publication.revision AS publication_revision,
  project.provenance_kind,
  'UNVERIFIED'::text AS evidence_status,
  project.title, project.short_description, project.contribution,
  project.materials_and_technologies, project.problem, project.solution,
  project.duration_value, project.duration_unit,
  project.indicative_price_min_cents, project.indicative_price_max_cents,
  project.municipality_code, project.district_code
FROM portfolio_project_publications publication
JOIN portfolio_project_publication_revisions revision
  ON revision.portfolio_project_id = publication.portfolio_project_id
  AND revision.revision = publication.revision
JOIN portfolio_projects project
  ON project.id = publication.portfolio_project_id
JOIN current_craftsman_profile_publications profile_publication
  ON profile_publication.craftsman_profile_id = publication.craftsman_profile_id
WHERE publication.state = 'PUBLIC'
  AND revision.state = 'PUBLIC'
  AND profile_publication.effectively_public
  AND project.record_state = 'DRAFT'
  AND project.provenance_kind = 'SELF_DECLARED'
  AND project.revision = revision.project_revision
  AND EXISTS (
    SELECT 1
    FROM portfolio_project_publication_items item
    JOIN media_asset_storage_objects object
      ON object.id = item.public_object_id
    WHERE item.revision_event_id = revision.event_id
      AND object.revoked_at IS NULL
  );

CREATE VIEW current_public_portfolio_project_photos AS
SELECT project.portfolio_project_id, project.craftsman_profile_id,
  project.publication_revision, item.media_asset_id, item.phase,
  item.display_order, item.canonical_width, item.canonical_height
FROM current_public_portfolio_projects project
JOIN portfolio_project_publication_revisions revision
  ON revision.portfolio_project_id = project.portfolio_project_id
  AND revision.revision = project.publication_revision
JOIN portfolio_project_publication_items item
  ON item.revision_event_id = revision.event_id
JOIN media_asset_storage_objects object
  ON object.id = item.public_object_id
WHERE object.revoked_at IS NULL;

CREATE VIEW current_public_portfolio_media_derivatives AS
SELECT item.media_asset_id, revision.portfolio_project_id,
  publication.revision AS publication_revision,
  publication.state AS publication_state,
  object.id AS object_id, object.role, object.storage_area,
  object.storage_key, object.content_type, object.public_url,
  object.revoked_at
FROM portfolio_project_publications publication
JOIN LATERAL (
  SELECT candidate.*
  FROM portfolio_project_publication_revisions candidate
  WHERE candidate.portfolio_project_id = publication.portfolio_project_id
    AND candidate.state = 'PUBLIC'
  ORDER BY candidate.revision DESC
  LIMIT 1
) revision ON true
JOIN portfolio_project_publication_items item
  ON item.revision_event_id = revision.event_id
JOIN media_asset_storage_objects object
  ON object.id = item.public_object_id;

COMMENT ON VIEW current_public_portfolio_projects IS
  'Allowlisted R1 public projects. Only current SELF_DECLARED owner publication is supported; future Job provenance remains fail-closed until exact customer-consent binding is added in R4.';
COMMENT ON VIEW current_public_portfolio_project_photos IS
  'Public photo metadata only. Storage keys, URLs, hashes, EXIF timestamps and customer identity are excluded.';
COMMENT ON VIEW current_public_portfolio_media_derivatives IS
  'Server-only delivery-reconciliation projection for the latest historical PUBLIC revision plus the current head state. Never serialize this view directly to clients.';
