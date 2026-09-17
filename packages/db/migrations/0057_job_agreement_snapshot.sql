-- The agreement record is constructed from historical server-owned rows in
-- the same transaction as Job creation. No client-supplied JSON is accepted.
CREATE TABLE job_agreement_snapshots (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  request_snapshot jsonb NOT NULL,
  quote_snapshot jsonb NOT NULL,
  pdf_media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  pdf_content_sha256 char(64),
  captured_at timestamptz NOT NULL,
  CONSTRAINT job_agreement_request_object CHECK (
    jsonb_typeof(request_snapshot) = 'object'
  ),
  CONSTRAINT job_agreement_quote_object CHECK (
    jsonb_typeof(quote_snapshot) = 'object'
  ),
  CONSTRAINT job_agreement_pdf_pair CHECK (
    (pdf_media_asset_id IS NULL) = (pdf_content_sha256 IS NULL)
  ),
  CONSTRAINT job_agreement_pdf_hash CHECK (
    pdf_content_sha256 IS NULL
    OR pdf_content_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE FUNCTION capture_job_agreement_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  quote_identity quote_revision_identities%ROWTYPE;
  request_sections jsonb;
  commercial_content jsonb;
  pdf_id uuid;
  pdf_hash char(64);
  section_count integer;
BEGIN
  SELECT * INTO quote_identity FROM quote_revision_identities
  WHERE quote_id = NEW.accepted_quote_id
    AND revision = NEW.accepted_quote_revision;
  IF quote_identity.quote_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM current_quote_revision_states current
    WHERE current.quote_id = NEW.accepted_quote_id
      AND current.revision = NEW.accepted_quote_revision
      AND current.state = 'SUBMITTED'
  ) THEN
    RAISE EXCEPTION 'submitted Quote revision required for Job snapshot';
  END IF;

  SELECT count(*), jsonb_object_agg(
    section.section_key,
    jsonb_build_object(
      'contentRevision', section.content_revision,
      'schemaVersion', 1,
      'origin', CASE WHEN section.content_revision IS NULL
        THEN 'DEFAULT' ELSE 'STORED' END,
      'payload', COALESCE(section.payload,
        job_request_default_section_payload(section.section_key)),
      'payloadFingerprint', section.payload_fingerprint
    )
  ) INTO section_count, request_sections
  FROM (
    SELECT keys.section_key, history.content_revision, history.payload,
      history.payload_fingerprint
    FROM (VALUES ('request.core'), ('request.location'),
      ('request.timing'), ('request.budget'), ('request.details'),
      ('request.media')) AS keys(section_key)
    LEFT JOIN LATERAL (
      SELECT source.content_revision, source.payload,
        source.payload_fingerprint
      FROM job_request_active_section_revisions source
      WHERE source.job_request_id = NEW.job_request_id
        AND source.section_key = keys.section_key
        AND source.content_revision <= NEW.accepted_request_content_revision
      ORDER BY source.content_revision DESC LIMIT 1
    ) history ON true
  ) section;
  IF section_count <> 6 THEN
    RAISE EXCEPTION 'complete historical request sections required';
  END IF;

  IF quote_identity.authoring_mode = 'PLATFORM_STRUCTURED' THEN
    SELECT to_jsonb(content) - 'command_id'
      INTO commercial_content
    FROM quote_structured_content_revisions content
    WHERE content.quote_id = NEW.accepted_quote_id
      AND content.quote_revision = NEW.accepted_quote_revision
    ORDER BY content.content_revision DESC LIMIT 1;
  ELSE
    SELECT to_jsonb(content) - 'command_id', content.pdf_media_asset_id,
      asset.document_content_sha256
      INTO commercial_content, pdf_id, pdf_hash
    FROM quote_external_pdf_content_revisions content
    JOIN media_assets asset ON asset.id = content.pdf_media_asset_id
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.storage_area = 'private'
      AND canonical.content_type = 'application/pdf'
      AND canonical.content_sha256 = asset.document_content_sha256
      AND canonical.revoked_at IS NULL
    WHERE content.quote_id = NEW.accepted_quote_id
      AND content.quote_revision = NEW.accepted_quote_revision
      AND asset.kind = 'DOCUMENT' AND asset.status = 'READY'
      AND asset.malware_scan_verdict = 'CLEAN'
    ORDER BY content.content_revision DESC LIMIT 1;
  END IF;
  IF commercial_content IS NULL
      OR (quote_identity.authoring_mode = 'EXTERNAL_PDF'
        AND (pdf_id IS NULL OR pdf_hash IS NULL)) THEN
    RAISE EXCEPTION 'complete immutable Quote content required';
  END IF;

  INSERT INTO job_agreement_snapshots (
    job_id, request_snapshot, quote_snapshot, pdf_media_asset_id,
    pdf_content_sha256, captured_at
  ) VALUES (
    NEW.id,
    jsonb_build_object(
      'jobRequestId', NEW.job_request_id,
      'contentRevision', NEW.accepted_request_content_revision,
      'visibleVersion', NEW.accepted_request_visible_version,
      'sections', request_sections
    ),
    jsonb_build_object(
      'quoteId', NEW.accepted_quote_id,
      'revision', NEW.accepted_quote_revision,
      'authoringMode', quote_identity.authoring_mode,
      'requestContentRevision', quote_identity.request_content_revision,
      'requestVisibleVersion', quote_identity.request_visible_version,
      'commercialContent', commercial_content,
      'pdfMediaAssetId', pdf_id,
      'pdfContentSha256', pdf_hash
    ),
    pdf_id, pdf_hash, NEW.accepted_at
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER jobs_capture_agreement_snapshot
AFTER INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION capture_job_agreement_snapshot();

CREATE FUNCTION reject_job_agreement_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accepted Job agreement snapshot is immutable';
END;
$$;

CREATE TRIGGER job_agreement_snapshots_immutable
BEFORE UPDATE OR DELETE ON job_agreement_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_agreement_snapshot_mutation();

COMMENT ON TABLE job_agreement_snapshots IS
  'Server-captured exact request sections, Quote content and external PDF integrity at Job creation. HTTP acceptance remains disabled until quote/competitor closeout is atomic.';
