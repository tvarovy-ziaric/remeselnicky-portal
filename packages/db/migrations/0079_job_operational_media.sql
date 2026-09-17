-- Attach only already-deliverable winning-conversation media. Original media,
-- upload author, capture time and private storage object remain canonical.
ALTER TABLE job_progress_updates
  ADD COLUMN creation_txid bigint NOT NULL DEFAULT txid_current();
ALTER TABLE job_issues
  ADD COLUMN creation_txid bigint NOT NULL DEFAULT txid_current();

CREATE TABLE job_progress_media (
  progress_update_id uuid NOT NULL REFERENCES job_progress_updates(id)
    ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (progress_update_id, media_asset_id),
  UNIQUE (progress_update_id, position)
);
CREATE TABLE job_issue_media (
  issue_id uuid NOT NULL REFERENCES job_issues(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (issue_id, media_asset_id),
  UNIQUE (issue_id, position)
);
CREATE INDEX job_progress_media_asset_idx ON job_progress_media (media_asset_id);
CREATE INDEX job_issue_media_asset_idx ON job_issue_media (media_asset_id);

CREATE FUNCTION validate_job_operational_media()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  original_txid bigint;
  original_author_id uuid;
  media_kind text;
BEGIN
  IF TG_TABLE_NAME = 'job_progress_media' THEN
    SELECT progress.job_id, progress.creation_txid, progress.author_user_id
      INTO target_job_id, original_txid, original_author_id
    FROM job_progress_updates progress
    WHERE progress.id = NEW.progress_update_id;
  ELSE
    SELECT issue.job_id, issue.creation_txid, issue.author_user_id
      INTO target_job_id, original_txid, original_author_id
    FROM job_issues issue WHERE issue.id = NEW.issue_id;
  END IF;
  IF target_job_id IS NULL OR original_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'operational media must be linked in creation transaction';
  END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM users actor
    JOIN auth_credentials credentials ON credentials.user_id = actor.id
    JOIN current_job_states state ON state.job_id = target_job_id
    WHERE actor.id = original_author_id
      AND actor.account_state = 'ACTIVE'
      AND credentials.email_verified_at IS NOT NULL
      AND credentials.phone_verified_at IS NOT NULL
      AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
  ) THEN
    RAISE EXCEPTION 'active open Job author required for operational media';
  END IF;
  SELECT media.media_kind::text INTO media_kind
  FROM job_conversation_media media
  JOIN media_assets asset ON asset.id = media.media_asset_id
    AND asset.status = 'READY'
    AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
  JOIN media_asset_storage_objects canonical
    ON canonical.media_asset_id = asset.id
    AND canonical.role = 'CANONICAL'
    AND canonical.storage_area = 'private'
    AND canonical.revoked_at IS NULL
  WHERE media.job_id = target_job_id
    AND media.media_asset_id = NEW.media_asset_id
    AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
      OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
        AND canonical.content_type = 'application/pdf'));
  IF media_kind IS NULL THEN
    RAISE EXCEPTION 'same-Job READY private clean media required';
  END IF;
  IF TG_TABLE_NAME = 'job_progress_media' AND media_kind <> 'IMAGE' THEN
    RAISE EXCEPTION 'progress updates accept photos only';
  END IF;
  NEW.linked_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_progress_media_validate BEFORE INSERT ON job_progress_media
  FOR EACH ROW EXECUTE FUNCTION validate_job_operational_media();
CREATE TRIGGER job_issue_media_validate BEFORE INSERT ON job_issue_media
  FOR EACH ROW EXECUTE FUNCTION validate_job_operational_media();

CREATE TRIGGER job_progress_media_immutable BEFORE UPDATE OR DELETE ON job_progress_media
  FOR EACH ROW EXECUTE FUNCTION reject_job_operational_mutation();
CREATE TRIGGER job_issue_media_immutable BEFORE UPDATE OR DELETE ON job_issue_media
  FOR EACH ROW EXECUTE FUNCTION reject_job_operational_mutation();

COMMENT ON TABLE job_progress_media IS
  'Immutable photo links; original Job conversation media retains provenance.';
COMMENT ON TABLE job_issue_media IS
  'Immutable private photo/PDF links to lightweight Job Issues.';
