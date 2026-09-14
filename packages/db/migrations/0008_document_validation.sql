ALTER TABLE media_assets
  ADD COLUMN document_page_count integer,
  ADD COLUMN document_content_sha256 character(64),
  ADD COLUMN malware_scan_verdict text,
  ADD COLUMN malware_scanned_at timestamptz,
  ADD COLUMN malware_scanner_engine text,
  ADD COLUMN malware_scanner_engine_version text,
  ADD COLUMN malware_signature_version text;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_ready_document_evidence_complete
    CHECK (
      (
        kind = 'DOCUMENT'
        AND status = 'READY'
        AND document_page_count BETWEEN 1 AND 200
        AND document_content_sha256 ~ '^[0-9a-f]{64}$'
        AND malware_scan_verdict = 'CLEAN'
        AND malware_scanned_at IS NOT NULL
        AND malware_scanner_engine ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'
        AND malware_scanner_engine_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'
        AND malware_signature_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'
        AND malware_scanned_at >= ready_at - interval '24 hours'
        AND malware_scanned_at <= ready_at + interval '5 minutes'
      )
      OR
      (
        (kind <> 'DOCUMENT' OR status <> 'READY')
        AND document_page_count IS NULL
        AND document_content_sha256 IS NULL
        AND malware_scan_verdict IS NULL
        AND malware_scanned_at IS NULL
        AND malware_scanner_engine IS NULL
        AND malware_scanner_engine_version IS NULL
        AND malware_signature_version IS NULL
      )
    );

CREATE FUNCTION guard_ready_document_canonical_object()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'DOCUMENT' AND NEW.status = 'READY' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM media_asset_storage_objects AS object
      WHERE object.media_asset_id = NEW.id
        AND object.role = 'CANONICAL'
        AND object.storage_area = 'private'
        AND object.content_type = 'application/pdf'
        AND object.content_sha256 = NEW.document_content_sha256
        AND object.revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'ready document requires matching private canonical object'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_assets_ready_document_canonical_guard
BEFORE INSERT OR UPDATE OF status, document_content_sha256 ON media_assets
FOR EACH ROW
EXECUTE FUNCTION guard_ready_document_canonical_object();
