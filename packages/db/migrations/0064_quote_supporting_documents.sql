-- A supporting document is included in exactly one Quote revision by an
-- explicit provider action, not by merely uploading it or mentioning it in chat.
CREATE TABLE quote_revision_supporting_documents (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  media_asset_id uuid NOT NULL UNIQUE
    REFERENCES media_assets(id) ON DELETE RESTRICT,
  attachment_command_id uuid NOT NULL UNIQUE,
  attached_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content_sha256 char(64) NOT NULL,
  attached_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, quote_revision, media_asset_id),
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT quote_supporting_document_revision_positive
    CHECK (quote_revision > 0),
  CONSTRAINT quote_supporting_document_hash
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION validate_quote_supporting_document()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_quote quotes%ROWTYPE;
  asset media_assets%ROWTYPE;
  canonical media_asset_storage_objects%ROWTYPE;
  request_id uuid;
  active_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.attachment_command_id::text, 50002)
  );
  SELECT * INTO source_quote FROM quotes quote WHERE quote.id = NEW.quote_id;
  IF source_quote.id IS NULL THEN
    RAISE EXCEPTION 'owned draft Quote required for supporting document';
  END IF;
  SELECT invitation.job_request_id INTO request_id
  FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(request_id::text, 41007));
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.attached_by_user_id
    AND actor.account_state = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Quote provider required for supporting document';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = source_quote.conversation_id FOR UPDATE;
  PERFORM 1 FROM quotes quote WHERE quote.id = NEW.quote_id FOR UPDATE;
  PERFORM 1 FROM quote_revision_heads head
  JOIN quote_revision_identities revision
    ON revision.quote_id = head.quote_id
    AND revision.revision = head.quote_revision
  WHERE head.quote_id = NEW.quote_id
    AND head.quote_revision = NEW.quote_revision
    AND head.state = 'DRAFT'
    AND quote_active_participant_context(
      source_quote.conversation_id, NEW.attached_by_user_id,
      'CRAFTSMAN', true
    )
  FOR UPDATE OF head;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned draft Quote required for supporting document';
  END IF;
  SELECT count(*)::integer INTO active_count
  FROM current_quote_revision_supporting_documents document
  WHERE document.quote_id = NEW.quote_id
    AND document.quote_revision = NEW.quote_revision;
  IF active_count >= 10 THEN
    RAISE EXCEPTION 'Quote supporting document limit reached';
  END IF;
  SELECT * INTO asset FROM media_assets
  WHERE id = NEW.media_asset_id FOR UPDATE;
  SELECT * INTO canonical FROM media_asset_storage_objects
  WHERE media_asset_id = NEW.media_asset_id
    AND role = 'CANONICAL' FOR UPDATE;
  IF asset.id IS NULL
      OR asset.owner_user_id <> NEW.attached_by_user_id
      OR asset.uploaded_by_user_id <> NEW.attached_by_user_id
      OR asset.kind <> 'DOCUMENT'
      OR asset.purpose <> 'QUOTE_DOCUMENT'
      OR asset.status <> 'READY'
      OR asset.provenance_entity_type <> 'QUOTE_REVISION'
      OR asset.provenance_entity_id <> NEW.quote_id
      OR asset.provenance_entity_revision <> NEW.quote_revision
      OR asset.declared_content_type <> 'application/pdf'
      OR asset.malware_scan_verdict IS DISTINCT FROM 'CLEAN'
      OR asset.document_content_sha256 IS NULL
      OR canonical.id IS NULL
      OR canonical.storage_area <> 'private'
      OR canonical.content_type <> 'application/pdf'
      OR canonical.revoked_at IS NOT NULL
      OR canonical.content_sha256 IS DISTINCT FROM
        asset.document_content_sha256 THEN
    RAISE EXCEPTION 'exact READY private Quote supporting PDF required';
  END IF;
  NEW.content_sha256 := asset.document_content_sha256;
  NEW.attached_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_supporting_documents_guard
BEFORE INSERT ON quote_revision_supporting_documents
FOR EACH ROW EXECUTE FUNCTION validate_quote_supporting_document();

CREATE FUNCTION reject_quote_supporting_document_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Quote supporting document inclusion is immutable';
END;
$$;

CREATE TRIGGER quote_supporting_documents_immutable
BEFORE UPDATE OR DELETE ON quote_revision_supporting_documents
FOR EACH ROW EXECUTE FUNCTION reject_quote_supporting_document_mutation();

-- A mistaken draft inclusion is excluded with a separate historical event.
-- The original inclusion remains provable; submitted revisions cannot change.
CREATE TABLE quote_revision_supporting_document_removals (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  media_asset_id uuid NOT NULL,
  removal_command_id uuid NOT NULL UNIQUE,
  removed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  removed_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, quote_revision, media_asset_id),
  FOREIGN KEY (quote_id, quote_revision, media_asset_id)
    REFERENCES quote_revision_supporting_documents(
      quote_id, quote_revision, media_asset_id
    ) ON DELETE RESTRICT
);

CREATE FUNCTION validate_quote_supporting_document_removal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_quote quotes%ROWTYPE;
  request_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.removal_command_id::text, 50003)
  );
  SELECT * INTO source_quote FROM quotes quote WHERE quote.id = NEW.quote_id;
  IF source_quote.id IS NULL THEN
    RAISE EXCEPTION 'owned draft Quote required for supporting-document removal';
  END IF;
  SELECT invitation.job_request_id INTO request_id
  FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(request_id::text, 41007));
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.removed_by_user_id
    AND actor.account_state = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned draft Quote required for supporting-document removal';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = source_quote.conversation_id FOR UPDATE;
  PERFORM 1 FROM quotes quote WHERE quote.id = NEW.quote_id FOR UPDATE;
  PERFORM 1 FROM quote_revision_heads head
  WHERE head.quote_id = NEW.quote_id
    AND head.quote_revision = NEW.quote_revision
    AND head.state = 'DRAFT'
    AND quote_active_participant_context(
      source_quote.conversation_id, NEW.removed_by_user_id,
      'CRAFTSMAN', true
    )
  FOR UPDATE OF head;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM quote_revision_supporting_documents document
    WHERE document.quote_id = NEW.quote_id
      AND document.quote_revision = NEW.quote_revision
      AND document.media_asset_id = NEW.media_asset_id
  ) THEN
    RAISE EXCEPTION 'owned draft Quote document inclusion required for removal';
  END IF;
  NEW.removed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_supporting_document_removals_guard
BEFORE INSERT ON quote_revision_supporting_document_removals
FOR EACH ROW EXECUTE FUNCTION validate_quote_supporting_document_removal();

CREATE TRIGGER quote_supporting_document_removals_immutable
BEFORE UPDATE OR DELETE ON quote_revision_supporting_document_removals
FOR EACH ROW EXECUTE FUNCTION reject_quote_supporting_document_mutation();

CREATE VIEW current_quote_revision_supporting_documents AS
SELECT document.*
FROM quote_revision_supporting_documents document
LEFT JOIN quote_revision_supporting_document_removals removal
  ON removal.quote_id = document.quote_id
  AND removal.quote_revision = document.quote_revision
  AND removal.media_asset_id = document.media_asset_id
WHERE removal.media_asset_id IS NULL;

CREATE TABLE job_quote_supporting_document_snapshots (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  included_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  included_at timestamptz NOT NULL,
  content_sha256 char(64) NOT NULL,
  display_filename text,
  byte_size integer NOT NULL,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, media_asset_id),
  FOREIGN KEY (quote_id, quote_revision, media_asset_id)
    REFERENCES quote_revision_supporting_documents(
      quote_id, quote_revision, media_asset_id
    ) ON DELETE RESTRICT,
  CONSTRAINT job_quote_supporting_document_hash
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT job_quote_supporting_document_size
    CHECK (byte_size > 0)
);

CREATE FUNCTION capture_job_quote_supporting_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source record;
  expected_count integer;
  captured_count integer := 0;
BEGIN
  SELECT count(*)::integer INTO expected_count
  FROM current_quote_revision_supporting_documents document
  WHERE document.quote_id = NEW.accepted_quote_id
    AND document.quote_revision = NEW.accepted_quote_revision;
  FOR source IN
    SELECT document.*, asset.display_filename, asset.byte_size,
      asset.document_content_sha256
    FROM current_quote_revision_supporting_documents document
    JOIN media_assets asset ON asset.id = document.media_asset_id
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.storage_area = 'private'
      AND canonical.content_type = 'application/pdf'
      AND canonical.revoked_at IS NULL
      AND canonical.content_sha256 = asset.document_content_sha256
    WHERE document.quote_id = NEW.accepted_quote_id
      AND document.quote_revision = NEW.accepted_quote_revision
      AND asset.status = 'READY'
      AND asset.malware_scan_verdict = 'CLEAN'
      AND asset.document_content_sha256 = document.content_sha256
    FOR SHARE OF asset, canonical
  LOOP
    INSERT INTO job_quote_supporting_document_snapshots (
      job_id, media_asset_id, quote_id, quote_revision,
      included_by_user_id, included_at, content_sha256,
      display_filename, byte_size, captured_at
    ) VALUES (
      NEW.id, source.media_asset_id, source.quote_id,
      source.quote_revision, source.attached_by_user_id,
      source.attached_at, source.content_sha256,
      source.display_filename, source.byte_size, NEW.accepted_at
    );
    captured_count := captured_count + 1;
  END LOOP;
  IF captured_count <> expected_count THEN
    RAISE EXCEPTION 'complete accepted Quote supporting documents required';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER jobs_capture_quote_supporting_documents
AFTER INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION capture_job_quote_supporting_documents();

CREATE TRIGGER job_quote_supporting_documents_immutable
BEFORE UPDATE OR DELETE ON job_quote_supporting_document_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_quote_supporting_document_mutation();

COMMENT ON TABLE quote_revision_supporting_documents IS
  'Provider-explicit, append-only PDF inclusion for one exact DRAFT Quote revision; chat attachments and unbound uploads are excluded.';
COMMENT ON TABLE quote_revision_supporting_document_removals IS
  'Append-only DRAFT-only exclusion of an accidentally included Quote document; the inclusion record is retained for audit.';
COMMENT ON TABLE job_quote_supporting_document_snapshots IS
  'Immutable accepted-Quote supporting-document identities and hashes captured atomically at Job creation; private binary access still requires current authorization.';
