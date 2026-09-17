-- A future Change-order PDF may be uploaded only into one pre-authorized,
-- exact Job/revision slot. No commercial document inherits JOB_DOCUMENT grants.
CREATE TABLE change_order_pdf_upload_reservations (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  change_order_id uuid NOT NULL,
  revision_id uuid NOT NULL UNIQUE,
  expected_revision_id uuid,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  provider_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_intent_sha256 char(64) NOT NULL CHECK (command_intent_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 hour'),
  CONSTRAINT change_order_pdf_initial_shape CHECK (
    (expected_revision_id IS NULL AND revision_number = 1
      AND id = change_order_id)
    OR (expected_revision_id IS NOT NULL AND revision_number > 1
      AND id = revision_id)
  )
);
CREATE INDEX change_order_pdf_reservations_job_idx
  ON change_order_pdf_upload_reservations (job_id, created_at DESC);

CREATE TABLE change_order_pdf_reserved_assets (
  reservation_id uuid PRIMARY KEY
    REFERENCES change_order_pdf_upload_reservations(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE RESTRICT,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_change_order_pdf_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_state_value job_state; side change_order_side;
  head_id uuid; head_number integer; head_state text; head_side change_order_side;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirmed Job required'; END IF;
  PERFORM 1 FROM users WHERE id = NEW.provider_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.provider_user_id FOR SHARE;
  SELECT state INTO job_state_value FROM current_job_states WHERE job_id = NEW.job_id;
  side := change_order_actor_side(NEW.job_id, NEW.provider_user_id);
  IF job_state_value NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR side IS DISTINCT FROM 'PRIMARY_PROVIDER' THEN
    RAISE EXCEPTION 'active primary provider required for Change-order PDF';
  END IF;
  SELECT current.revision_id, current.revision_number, current.state,
    revision.authored_side INTO head_id, head_number, head_state, head_side
  FROM current_change_orders current
  JOIN change_order_revisions revision ON revision.id = current.revision_id
  WHERE current.id = NEW.change_order_id AND current.job_id = NEW.job_id;
  IF head_id IS NULL THEN
    IF NEW.expected_revision_id IS NOT NULL OR NEW.revision_number <> 1
      OR EXISTS (SELECT 1 FROM change_orders identity
        WHERE identity.id = NEW.change_order_id) THEN
      RAISE EXCEPTION 'new Change-order PDF requires reserved first revision';
    END IF;
  ELSE
    IF NEW.expected_revision_id IS DISTINCT FROM head_id
      OR NEW.revision_number IS DISTINCT FROM head_number + 1
      OR NOT ((head_state = 'DRAFT' AND head_side = 'PRIMARY_PROVIDER')
        OR (head_state = 'PROPOSED' AND head_side = 'CUSTOMER')) THEN
      RAISE EXCEPTION 'stale or unauthorized Change-order PDF revision';
    END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.expires_at := NEW.created_at + interval '1 hour';
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_change_order_pdf_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation change_order_pdf_upload_reservations%ROWTYPE;
  job_state_value job_state;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.purpose = 'CHANGE_ORDER_DOCUMENT'
      OR NEW.purpose = 'CHANGE_ORDER_DOCUMENT') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.declared_content_type IS DISTINCT FROM OLD.declared_content_type
      OR NEW.display_filename IS DISTINCT FROM OLD.display_filename
      OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
      OR NEW.provenance_entity_type IS DISTINCT FROM OLD.provenance_entity_type
      OR NEW.provenance_entity_id IS DISTINCT FROM OLD.provenance_entity_id
      OR NEW.provenance_entity_revision IS DISTINCT FROM OLD.provenance_entity_revision
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Change-order document media identity is immutable';
    END IF;
    IF OLD.status IN ('READY', 'REJECTED') AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
      OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
      OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
      OR NEW.rejection_code IS DISTINCT FROM OLD.rejection_code
      OR NEW.document_page_count IS DISTINCT FROM OLD.document_page_count
      OR NEW.document_content_sha256 IS DISTINCT FROM OLD.document_content_sha256
      OR NEW.malware_scan_verdict IS DISTINCT FROM OLD.malware_scan_verdict
      OR NEW.malware_scanned_at IS DISTINCT FROM OLD.malware_scanned_at
      OR NEW.malware_scanner_engine IS DISTINCT FROM OLD.malware_scanner_engine
      OR NEW.malware_scanner_engine_version IS DISTINCT FROM OLD.malware_scanner_engine_version
      OR NEW.malware_signature_version IS DISTINCT FROM OLD.malware_signature_version
    ) THEN RAISE EXCEPTION 'terminal Change-order PDF media is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.purpose <> 'CHANGE_ORDER_DOCUMENT' THEN RETURN NEW; END IF;
  IF NEW.kind <> 'DOCUMENT' OR NEW.status <> 'PROCESSING'
    OR NEW.declared_content_type <> 'application/pdf'
    OR NEW.owner_user_id IS DISTINCT FROM NEW.uploaded_by_user_id
    OR NEW.provenance_entity_type <> 'CHANGE_ORDER_REVISION'
    OR NEW.provenance_entity_id IS NULL
    OR NEW.provenance_entity_revision IS NULL THEN
    RAISE EXCEPTION 'exact owned Change-order revision PDF provenance required';
  END IF;
  SELECT * INTO reservation FROM change_order_pdf_upload_reservations
    WHERE revision_id = NEW.provenance_entity_id;
  IF reservation.id IS NULL THEN
    RAISE EXCEPTION 'live one-use Change-order PDF reservation required';
  END IF;
  PERFORM 1 FROM jobs WHERE id = reservation.job_id FOR UPDATE;
  SELECT * INTO reservation FROM change_order_pdf_upload_reservations
    WHERE id = reservation.id FOR UPDATE;
  IF reservation.id IS NULL
    OR reservation.provider_user_id IS DISTINCT FROM NEW.owner_user_id
    OR reservation.revision_number IS DISTINCT FROM NEW.provenance_entity_revision
    OR reservation.expires_at <= clock_timestamp()
    OR EXISTS (SELECT 1 FROM change_order_pdf_reserved_assets bound
      WHERE bound.reservation_id = reservation.id)
    OR EXISTS (SELECT 1 FROM change_order_revisions revision
      WHERE revision.id = reservation.revision_id) THEN
    RAISE EXCEPTION 'live one-use Change-order PDF reservation required';
  END IF;
  SELECT state INTO job_state_value FROM current_job_states
    WHERE job_id = reservation.job_id;
  IF job_state_value NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR change_order_actor_side(reservation.job_id, NEW.owner_user_id)
      IS DISTINCT FROM 'PRIMARY_PROVIDER' THEN
    RAISE EXCEPTION 'active primary provider required for Change-order PDF';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION bind_change_order_pdf_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_id uuid;
BEGIN
  IF NEW.purpose <> 'CHANGE_ORDER_DOCUMENT' THEN RETURN NULL; END IF;
  SELECT id INTO reservation_id FROM change_order_pdf_upload_reservations
    WHERE revision_id = NEW.provenance_entity_id
      AND revision_number = NEW.provenance_entity_revision;
  IF reservation_id IS NULL THEN RAISE EXCEPTION 'Change-order PDF reservation missing'; END IF;
  INSERT INTO change_order_pdf_reserved_assets (reservation_id, media_asset_id)
    VALUES (reservation_id, NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_change_order_reserved_pdf_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserved change_order_pdf_upload_reservations%ROWTYPE;
DECLARE bound_asset_id uuid;
DECLARE target_job_id uuid;
BEGIN
  IF NEW.document_mode <> 'EXTERNAL_PDF' THEN RETURN NEW; END IF;
  SELECT * INTO reserved FROM change_order_pdf_upload_reservations
    WHERE revision_id = NEW.id FOR UPDATE;
  SELECT job_id INTO target_job_id FROM change_orders
    WHERE id = NEW.change_order_id;
  SELECT media_asset_id INTO bound_asset_id FROM change_order_pdf_reserved_assets
    WHERE reservation_id = reserved.id;
  IF reserved.id IS NULL OR reserved.job_id IS DISTINCT FROM target_job_id
    OR reserved.change_order_id IS DISTINCT FROM NEW.change_order_id
    OR reserved.revision_number IS DISTINCT FROM NEW.revision_number
    OR reserved.provider_user_id IS DISTINCT FROM NEW.authored_by_user_id
    OR reserved.expires_at <= clock_timestamp()
    OR bound_asset_id IS DISTINCT FROM NEW.pdf_media_asset_id THEN
    RAISE EXCEPTION 'unexpired exact Change-order PDF reservation and asset required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_change_order_pdf_reservation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Change-order PDF reservation history is immutable'; END;
$$;

CREATE TRIGGER change_order_pdf_reservation_validate BEFORE INSERT
  ON change_order_pdf_upload_reservations FOR EACH ROW
  EXECUTE FUNCTION validate_change_order_pdf_reservation();
CREATE TRIGGER change_order_pdf_asset_guard BEFORE INSERT OR UPDATE
  ON media_assets FOR EACH ROW EXECUTE FUNCTION guard_change_order_pdf_asset();
CREATE TRIGGER change_order_pdf_asset_bind AFTER INSERT ON media_assets
  FOR EACH ROW EXECUTE FUNCTION bind_change_order_pdf_asset();
CREATE TRIGGER zz_change_order_reserved_pdf_revision BEFORE INSERT
  ON change_order_revisions FOR EACH ROW
  EXECUTE FUNCTION validate_change_order_reserved_pdf_revision();
CREATE TRIGGER change_order_pdf_reservation_immutable BEFORE UPDATE OR DELETE
  ON change_order_pdf_upload_reservations FOR EACH ROW
  EXECUTE FUNCTION reject_change_order_pdf_reservation_mutation();
CREATE TRIGGER change_order_pdf_asset_binding_immutable BEFORE UPDATE OR DELETE
  ON change_order_pdf_reserved_assets FOR EACH ROW
  EXECUTE FUNCTION reject_change_order_pdf_reservation_mutation();

COMMENT ON TABLE change_order_pdf_upload_reservations IS
  'One-hour, provider-only, exact Job/future revision upload intent; never a public grant.';
