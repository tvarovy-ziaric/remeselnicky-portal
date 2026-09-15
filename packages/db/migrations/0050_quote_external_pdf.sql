CREATE FUNCTION validate_quote_document_media_provenance()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE source_quote quotes%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.purpose = 'QUOTE_DOCUMENT'
      OR NEW.purpose = 'QUOTE_DOCUMENT') THEN
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
      RAISE EXCEPTION 'Quote document media identity is immutable';
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
      ) THEN
      RAISE EXCEPTION 'terminal Quote document media state is immutable';
    END IF;
    IF OLD.status = 'PROCESSING'
        AND NEW.status NOT IN ('PROCESSING', 'READY', 'REJECTED') THEN
      RAISE EXCEPTION 'invalid Quote document media transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.purpose <> 'QUOTE_DOCUMENT' THEN RETURN NEW; END IF;
  IF NEW.kind <> 'DOCUMENT' OR NEW.status <> 'PROCESSING'
      OR NEW.declared_content_type <> 'application/pdf'
      OR NEW.owner_user_id <> NEW.uploaded_by_user_id
      OR NEW.provenance_entity_type <> 'QUOTE_REVISION'
      OR NEW.provenance_entity_id IS NULL
      OR NEW.provenance_entity_revision IS NULL THEN
    RAISE EXCEPTION 'exact owned Quote revision PDF provenance required';
  END IF;
  PERFORM 1 FROM users actor WHERE actor.id = NEW.owner_user_id
    AND actor.account_state = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exact owned Quote revision PDF provenance required'; END IF;
  SELECT * INTO source_quote FROM quotes quote
    WHERE quote.id = NEW.provenance_entity_id;
  IF source_quote.id IS NULL THEN
    RAISE EXCEPTION 'exact owned Quote revision PDF provenance required';
  END IF;
  PERFORM 1 FROM job_invitations invitation
    WHERE invitation.id = source_quote.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
    WHERE conversation.id = source_quote.conversation_id FOR UPDATE;
  PERFORM 1 FROM quotes quote WHERE quote.id = source_quote.id FOR UPDATE;
  PERFORM 1 FROM quote_revision_identities revision
    JOIN quote_revision_heads head ON head.quote_id = revision.quote_id
      AND head.quote_revision = revision.revision
    WHERE revision.quote_id = source_quote.id
      AND revision.revision = NEW.provenance_entity_revision
      AND head.state = 'DRAFT' FOR UPDATE OF head;
  IF NOT FOUND OR NOT quote_active_participant_context(
      source_quote.conversation_id, NEW.owner_user_id, 'CRAFTSMAN', true
    ) THEN RAISE EXCEPTION 'exact owned Quote revision PDF provenance required'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_document_media_provenance_guard
BEFORE INSERT OR UPDATE ON media_assets
FOR EACH ROW EXECUTE FUNCTION validate_quote_document_media_provenance();

CREATE TABLE quote_external_pdf_authoring_commands (
  command_id uuid PRIMARY KEY,
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pdf_media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  provider_confirmed_summary_matches_pdf boolean NOT NULL,
  expected_content_revision integer NOT NULL,
  resulting_content_revision integer NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision) ON DELETE RESTRICT,
  CONSTRAINT quote_external_pdf_commands_revision CHECK (
    expected_content_revision >= 0
    AND resulting_content_revision = expected_content_revision + 1
  ),
  CONSTRAINT quote_external_pdf_commands_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT quote_external_pdf_command_confirmation_true CHECK (
    provider_confirmed_summary_matches_pdf
  )
);

CREATE TABLE quote_external_pdf_documents (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  pdf_media_asset_id uuid NOT NULL UNIQUE
    REFERENCES media_assets(id) ON DELETE RESTRICT,
  attached_by_command_id uuid NOT NULL UNIQUE
    REFERENCES quote_external_pdf_authoring_commands(command_id)
    ON DELETE RESTRICT,
  attached_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, quote_revision, pdf_media_asset_id),
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision) ON DELETE RESTRICT,
  UNIQUE (quote_id, quote_revision, pdf_media_asset_id)
);

CREATE TABLE quote_external_pdf_content_revisions (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  content_revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES quote_external_pdf_authoring_commands(command_id)
    ON DELETE RESTRICT,
  pdf_media_asset_id uuid NOT NULL,
  price_mode structured_quote_price_mode NOT NULL,
  currency char(3) NOT NULL,
  total_amount_cents bigint,
  range_minimum_cents bigint,
  range_maximum_cents bigint,
  vat_status structured_quote_vat_status NOT NULL,
  estimated_start_on date,
  estimated_duration_days integer,
  valid_until timestamptz,
  material_responsibility structured_quote_material_responsibility,
  deposit_mode structured_quote_deposit_mode,
  deposit_amount_cents bigint,
  deposit_percentage_basis_points integer,
  provider_confirmed_summary_matches_pdf boolean NOT NULL,
  confirmed_at timestamptz NOT NULL,
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, quote_revision, content_revision),
  FOREIGN KEY (quote_id, quote_revision, pdf_media_asset_id)
    REFERENCES quote_external_pdf_documents(
      quote_id, quote_revision, pdf_media_asset_id
    ) ON DELETE RESTRICT,
  CONSTRAINT quote_external_pdf_content_revision_positive
    CHECK (content_revision > 0),
  CONSTRAINT quote_external_pdf_currency_eur CHECK (currency = 'EUR'),
  CONSTRAINT quote_external_pdf_price_shape CHECK (
    (price_mode = 'RANGE' AND total_amount_cents IS NULL
      AND range_minimum_cents BETWEEN 1 AND 1000000000000
      AND range_maximum_cents BETWEEN 1 AND 1000000000000
      AND range_minimum_cents <= range_maximum_cents)
    OR (price_mode IN ('FIXED', 'ESTIMATE')
      AND total_amount_cents BETWEEN 1 AND 1000000000000
      AND range_minimum_cents IS NULL AND range_maximum_cents IS NULL)
  ),
  CONSTRAINT quote_external_pdf_timing_bounds CHECK (
    estimated_duration_days IS NULL
    OR estimated_duration_days BETWEEN 1 AND 3650
  ),
  CONSTRAINT quote_external_pdf_deposit_shape CHECK (
    (deposit_mode IS NULL AND deposit_amount_cents IS NULL
      AND deposit_percentage_basis_points IS NULL)
    OR (deposit_mode = 'NONE' AND deposit_amount_cents IS NULL
      AND deposit_percentage_basis_points IS NULL)
    OR (deposit_mode = 'FIXED_AMOUNT'
      AND deposit_amount_cents BETWEEN 1 AND 1000000000000
      AND deposit_percentage_basis_points IS NULL)
    OR (deposit_mode = 'PERCENTAGE' AND deposit_amount_cents IS NULL
      AND deposit_percentage_basis_points BETWEEN 1 AND 10000)
  ),
  CONSTRAINT quote_external_pdf_provider_confirmation_true
    CHECK (provider_confirmed_summary_matches_pdf)
);

ALTER TABLE quote_external_pdf_content_revisions
  ADD CONSTRAINT quote_external_pdf_content_command_effect_unique UNIQUE (
    command_id, quote_id, quote_revision, content_revision
  );
ALTER TABLE quote_external_pdf_authoring_commands
  ADD CONSTRAINT quote_external_pdf_command_effect_fk FOREIGN KEY (
    command_id, quote_id, quote_revision, resulting_content_revision
  ) REFERENCES quote_external_pdf_content_revisions(
    command_id, quote_id, quote_revision, content_revision
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE VIEW current_quote_external_pdf_content AS
SELECT DISTINCT ON (content.quote_id, content.quote_revision) content.*
FROM quote_external_pdf_content_revisions content
ORDER BY content.quote_id, content.quote_revision,
  content.content_revision DESC;

CREATE FUNCTION validate_quote_external_pdf_authoring_command()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  source_quote quotes%ROWTYPE;
  source_revision quote_revision_identities%ROWTYPE;
  source_head quote_revision_heads%ROWTYPE;
  current_content_revision integer;
  asset media_assets%ROWTYPE;
  canonical media_asset_storage_objects%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.command_id::text, 50001));
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned external PDF Quote context required'; END IF;

  SELECT * INTO source_quote FROM quotes quote WHERE quote.id = NEW.quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned external PDF Quote context required'; END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = source_quote.conversation_id FOR UPDATE;
  PERFORM 1 FROM quotes quote WHERE quote.id = NEW.quote_id FOR UPDATE;

  IF NOT quote_active_participant_context(
    source_quote.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', false
  ) THEN RAISE EXCEPTION 'owned external PDF Quote context required'; END IF;
  IF NOT quote_active_participant_context(
    source_quote.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', true
  ) THEN RAISE EXCEPTION 'writable external PDF Quote context required'; END IF;

  SELECT * INTO source_revision FROM quote_revision_identities identity
  WHERE identity.quote_id = NEW.quote_id
    AND identity.revision = NEW.quote_revision;
  SELECT * INTO source_head FROM quote_revision_heads head
  WHERE head.quote_id = NEW.quote_id
    AND head.quote_revision = NEW.quote_revision FOR UPDATE;
  IF source_revision.quote_id IS NULL
      OR source_revision.authoring_mode <> 'EXTERNAL_PDF'
      OR source_head.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'editable EXTERNAL_PDF Quote draft required';
  END IF;

  SELECT * INTO asset FROM media_assets item
  WHERE item.id = NEW.pdf_media_asset_id FOR UPDATE;
  SELECT * INTO canonical FROM media_asset_storage_objects object
  WHERE object.media_asset_id = NEW.pdf_media_asset_id
    AND object.role = 'CANONICAL' FOR UPDATE;
  IF asset.id IS NULL OR asset.owner_user_id <> NEW.actor_user_id
      OR asset.uploaded_by_user_id <> NEW.actor_user_id
      OR asset.kind <> 'DOCUMENT' OR asset.purpose <> 'QUOTE_DOCUMENT'
      OR asset.status <> 'READY'
      OR asset.provenance_entity_type <> 'QUOTE_REVISION'
      OR asset.provenance_entity_id <> NEW.quote_id
      OR asset.provenance_entity_revision <> NEW.quote_revision
      OR asset.declared_content_type <> 'application/pdf'
      OR canonical.id IS NULL OR canonical.storage_area <> 'private'
      OR canonical.content_type <> 'application/pdf'
      OR canonical.revoked_at IS NOT NULL
      OR canonical.content_sha256 IS DISTINCT FROM asset.document_content_sha256 THEN
    RAISE EXCEPTION 'exact READY private Quote PDF required';
  END IF;

  SELECT content.content_revision INTO current_content_revision
  FROM current_quote_external_pdf_content content
  WHERE content.quote_id = NEW.quote_id
    AND content.quote_revision = NEW.quote_revision;
  current_content_revision := coalesce(current_content_revision, 0);
  IF current_content_revision <> NEW.expected_content_revision THEN
    RAISE EXCEPTION 'external PDF Quote content revision is stale';
  END IF;
  NEW.resulting_content_revision := current_content_revision + 1;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_external_pdf_authoring_commands_guard
BEFORE INSERT ON quote_external_pdf_authoring_commands
FOR EACH ROW EXECUTE FUNCTION validate_quote_external_pdf_authoring_command();

CREATE FUNCTION validate_quote_external_pdf_document()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_external_pdf_authoring_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM quote_external_pdf_authoring_commands command
  WHERE command.command_id = NEW.attached_by_command_id FOR UPDATE;
  IF source.command_id IS NULL OR source.quote_id <> NEW.quote_id
      OR source.quote_revision <> NEW.quote_revision
      OR source.pdf_media_asset_id <> NEW.pdf_media_asset_id THEN
    RAISE EXCEPTION 'external PDF document requires exact command';
  END IF;
  NEW.attached_at := source.created_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quote_external_pdf_documents_guard
BEFORE INSERT ON quote_external_pdf_documents
FOR EACH ROW EXECUTE FUNCTION validate_quote_external_pdf_document();

CREATE FUNCTION validate_quote_external_pdf_content_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_external_pdf_authoring_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM quote_external_pdf_authoring_commands command
  WHERE command.command_id = NEW.command_id FOR UPDATE;
  IF source.command_id IS NULL OR source.quote_id <> NEW.quote_id
      OR source.quote_revision <> NEW.quote_revision
      OR source.pdf_media_asset_id <> NEW.pdf_media_asset_id THEN
    RAISE EXCEPTION 'external PDF content requires exact command';
  END IF;
  NEW.content_revision := source.resulting_content_revision;
  NEW.provider_confirmed_summary_matches_pdf :=
    source.provider_confirmed_summary_matches_pdf;
  NEW.confirmed_at := source.created_at;
  NEW.saved_at := source.created_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quote_external_pdf_content_revisions_command_guard
BEFORE INSERT ON quote_external_pdf_content_revisions
FOR EACH ROW EXECUTE FUNCTION validate_quote_external_pdf_content_revision();

CREATE FUNCTION reject_quote_external_pdf_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'external PDF Quote history is append-only'; END;
$$;
CREATE TRIGGER quote_external_pdf_commands_append_only
BEFORE UPDATE OR DELETE ON quote_external_pdf_authoring_commands
FOR EACH ROW EXECUTE FUNCTION reject_quote_external_pdf_mutation();
CREATE TRIGGER quote_external_pdf_documents_append_only
BEFORE UPDATE OR DELETE ON quote_external_pdf_documents
FOR EACH ROW EXECUTE FUNCTION reject_quote_external_pdf_mutation();
CREATE TRIGGER quote_external_pdf_content_append_only
BEFORE UPDATE OR DELETE ON quote_external_pdf_content_revisions
FOR EACH ROW EXECUTE FUNCTION reject_quote_external_pdf_mutation();

CREATE OR REPLACE FUNCTION quote_revision_authoring_is_eligible(
  target_quote_id uuid,
  target_quote_revision integer,
  target_mode quote_authoring_mode
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  content quote_external_pdf_content_revisions%ROWTYPE;
  document quote_external_pdf_documents%ROWTYPE;
  asset media_assets%ROWTYPE;
  canonical media_asset_storage_objects%ROWTYPE;
BEGIN
  IF target_mode = 'PLATFORM_STRUCTURED' THEN
    RETURN EXISTS (
      SELECT 1 FROM current_quote_structured_content item
      WHERE item.quote_id = target_quote_id
        AND item.quote_revision = target_quote_revision
        AND (item.valid_until IS NULL
          OR item.valid_until > clock_timestamp())
    );
  END IF;
  IF target_mode <> 'EXTERNAL_PDF' THEN RETURN false; END IF;

  SELECT * INTO content FROM current_quote_external_pdf_content item
  WHERE item.quote_id = target_quote_id
    AND item.quote_revision = target_quote_revision;
  IF content.pdf_media_asset_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO document FROM quote_external_pdf_documents item
  WHERE item.quote_id = target_quote_id
    AND item.quote_revision = target_quote_revision
    AND item.pdf_media_asset_id = content.pdf_media_asset_id FOR UPDATE;
  IF document.pdf_media_asset_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO asset FROM media_assets item
  WHERE item.id = document.pdf_media_asset_id FOR UPDATE;
  SELECT * INTO canonical FROM media_asset_storage_objects object
  WHERE object.media_asset_id = document.pdf_media_asset_id
    AND object.role = 'CANONICAL' FOR UPDATE;
  RETURN coalesce(content.quote_id IS NOT NULL
    AND content.pdf_media_asset_id = document.pdf_media_asset_id
    AND content.provider_confirmed_summary_matches_pdf
    AND (content.valid_until IS NULL OR content.valid_until > clock_timestamp())
    AND asset.id IS NOT NULL AND asset.status = 'READY'
    AND asset.kind = 'DOCUMENT' AND asset.purpose = 'QUOTE_DOCUMENT'
    AND asset.provenance_entity_type = 'QUOTE_REVISION'
    AND asset.provenance_entity_id = target_quote_id
    AND asset.provenance_entity_revision = target_quote_revision
    AND canonical.id IS NOT NULL AND canonical.storage_area = 'private'
    AND canonical.content_type = 'application/pdf'
    AND canonical.revoked_at IS NULL
    AND canonical.content_sha256 = asset.document_content_sha256, false);
END;
$$;

CREATE INDEX quote_external_pdf_content_history_idx
  ON quote_external_pdf_content_revisions(
    quote_id, quote_revision, content_revision DESC
  );

COMMENT ON TABLE quote_external_pdf_documents IS
  'Globally unique immutable PDF bindings; a DRAFT may select a newer asset through a new CAS content revision without overwriting history.';
COMMENT ON COLUMN quote_external_pdf_content_revisions.provider_confirmed_summary_matches_pdf IS
  'Immutable provider confirmation required by D16; confirmed_at is derived from the exact save command.';
