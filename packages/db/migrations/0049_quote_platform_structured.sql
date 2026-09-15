CREATE TYPE structured_quote_price_mode AS ENUM ('FIXED', 'ESTIMATE', 'RANGE');
CREATE TYPE structured_quote_vat_status AS ENUM (
  'VAT_INCLUDED', 'VAT_EXCLUDED', 'NOT_VAT_REGISTERED'
);
CREATE TYPE structured_quote_material_responsibility AS ENUM (
  'PROVIDER', 'CUSTOMER', 'MIXED'
);
CREATE TYPE structured_quote_deposit_mode AS ENUM (
  'NONE', 'FIXED_AMOUNT', 'PERCENTAGE'
);

CREATE TABLE quote_structured_authoring_commands (
  command_id uuid PRIMARY KEY,
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expected_content_revision integer NOT NULL,
  resulting_content_revision integer NOT NULL,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT quote_structured_commands_revision CHECK (
    expected_content_revision >= 0
    AND resulting_content_revision = expected_content_revision + 1
  ),
  CONSTRAINT quote_structured_commands_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE FUNCTION quote_structured_text_is_valid(
  candidate text, maximum_characters integer
)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT char_length(candidate) BETWEEN 1 AND maximum_characters
    AND octet_length(candidate) <= maximum_characters * 4
    AND candidate !~ '^[[:space:]]'
    AND right(candidate, 1) !~ '[[:space:]]'
    AND left(candidate, 1) NOT IN (
      chr(160), chr(5760), chr(8192), chr(8193), chr(8194), chr(8195),
      chr(8196), chr(8197), chr(8198), chr(8199), chr(8200), chr(8201),
      chr(8202), chr(8232), chr(8233), chr(8239), chr(8287), chr(12288),
      chr(65279)
    )
    AND right(candidate, 1) NOT IN (
      chr(160), chr(5760), chr(8192), chr(8193), chr(8194), chr(8195),
      chr(8196), chr(8197), chr(8198), chr(8199), chr(8200), chr(8201),
      chr(8202), chr(8232), chr(8233), chr(8239), chr(8287), chr(12288),
      chr(65279)
    )
    AND position(chr(13) in candidate) = 0
    AND candidate !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    AND NOT conversation_message_violates_preconfirm_policy(candidate);
$$;

CREATE TABLE quote_structured_content_revisions (
  quote_id uuid NOT NULL,
  quote_revision integer NOT NULL,
  content_revision integer NOT NULL,
  command_id uuid NOT NULL UNIQUE
    REFERENCES quote_structured_authoring_commands(command_id)
    ON DELETE RESTRICT,
  title text NOT NULL,
  summary text NOT NULL,
  price_mode structured_quote_price_mode NOT NULL,
  currency char(3) NOT NULL,
  total_amount_cents bigint,
  range_minimum_cents bigint,
  range_maximum_cents bigint,
  price_basis text NOT NULL,
  vat_status structured_quote_vat_status NOT NULL,
  labor_amount_cents bigint,
  labor_description text,
  material_amount_cents bigint,
  material_description text,
  transport_amount_cents bigint,
  transport_description text,
  other_amount_cents bigint,
  other_description text,
  included_scope text[] NOT NULL,
  excluded_scope text[] NOT NULL,
  conditional_on_inspection boolean NOT NULL,
  inspection_conditions text,
  estimated_start_on date,
  estimated_duration_days integer,
  valid_until timestamptz,
  warranty_information text,
  material_responsibility structured_quote_material_responsibility NOT NULL,
  deposit_mode structured_quote_deposit_mode,
  deposit_amount_cents bigint,
  deposit_percentage_basis_points integer,
  deposit_notes text,
  provider_notes text,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, quote_revision, content_revision),
  FOREIGN KEY (quote_id, quote_revision)
    REFERENCES quote_revision_identities(quote_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT quote_structured_content_revision_positive CHECK (
    content_revision > 0
  ),
  CONSTRAINT quote_structured_currency_eur CHECK (currency = 'EUR'),
  CONSTRAINT quote_structured_price_shape CHECK (
    (price_mode = 'RANGE'
      AND total_amount_cents IS NULL
      AND range_minimum_cents BETWEEN 1 AND 1000000000000
      AND range_maximum_cents BETWEEN 1 AND 1000000000000
      AND range_minimum_cents <= range_maximum_cents)
    OR (price_mode IN ('FIXED', 'ESTIMATE')
      AND total_amount_cents BETWEEN 1 AND 1000000000000
      AND range_minimum_cents IS NULL AND range_maximum_cents IS NULL)
  ),
  CONSTRAINT quote_structured_component_amounts CHECK (
    (labor_amount_cents IS NULL
      OR labor_amount_cents BETWEEN 0 AND 1000000000000)
    AND (material_amount_cents IS NULL
      OR material_amount_cents BETWEEN 0 AND 1000000000000)
    AND (transport_amount_cents IS NULL
      OR transport_amount_cents BETWEEN 0 AND 1000000000000)
    AND (other_amount_cents IS NULL
      OR other_amount_cents BETWEEN 0 AND 1000000000000)
  ),
  CONSTRAINT quote_structured_transport_basis CHECK (
    transport_amount_cents IS NULL OR transport_description IS NOT NULL
  ),
  CONSTRAINT quote_structured_inspection_shape CHECK (
    (conditional_on_inspection AND inspection_conditions IS NOT NULL)
    OR (NOT conditional_on_inspection AND inspection_conditions IS NULL)
  ),
  CONSTRAINT quote_structured_timing_bounds CHECK (
    estimated_duration_days IS NULL
    OR estimated_duration_days BETWEEN 1 AND 3650
  ),
  CONSTRAINT quote_structured_deposit_shape CHECK (
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
  CONSTRAINT quote_structured_required_text CHECK (
    quote_structured_text_is_valid(title, 160)
    AND quote_structured_text_is_valid(summary, 1000)
    AND quote_structured_text_is_valid(price_basis, 500)
  ),
  CONSTRAINT quote_structured_optional_text CHECK (
    (labor_description IS NULL
      OR quote_structured_text_is_valid(labor_description, 1000))
    AND (material_description IS NULL
      OR quote_structured_text_is_valid(material_description, 1000))
    AND (transport_description IS NULL
      OR quote_structured_text_is_valid(transport_description, 1000))
    AND (other_description IS NULL
      OR quote_structured_text_is_valid(other_description, 1000))
    AND (inspection_conditions IS NULL
      OR quote_structured_text_is_valid(inspection_conditions, 1000))
    AND (warranty_information IS NULL
      OR quote_structured_text_is_valid(warranty_information, 1000))
    AND (deposit_notes IS NULL
      OR quote_structured_text_is_valid(deposit_notes, 500))
    AND (provider_notes IS NULL
      OR quote_structured_text_is_valid(provider_notes, 2000))
  ),
  CONSTRAINT quote_structured_scope_bounds CHECK (
    cardinality(included_scope) <= 20
    AND cardinality(excluded_scope) <= 20
    AND CASE WHEN cardinality(included_scope) = 0 THEN true
      WHEN array_ndims(included_scope) = 1
        AND array_lower(included_scope, 1) = 1
        THEN array_position(included_scope, NULL) IS NULL
      ELSE false
    END
    AND CASE WHEN cardinality(excluded_scope) = 0 THEN true
      WHEN array_ndims(excluded_scope) = 1
        AND array_lower(excluded_scope, 1) = 1
        THEN array_position(excluded_scope, NULL) IS NULL
      ELSE false
    END
  )
);

ALTER TABLE quote_structured_content_revisions
  ADD CONSTRAINT quote_structured_content_command_effect_unique UNIQUE (
    command_id, quote_id, quote_revision, content_revision
  );

ALTER TABLE quote_structured_authoring_commands
  ADD CONSTRAINT quote_structured_command_effect_fk
  FOREIGN KEY (
    command_id, quote_id, quote_revision, resulting_content_revision
  ) REFERENCES quote_structured_content_revisions(
    command_id, quote_id, quote_revision, content_revision
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE VIEW current_quote_structured_content AS
SELECT DISTINCT ON (content.quote_id, content.quote_revision)
  content.*
FROM quote_structured_content_revisions content
ORDER BY content.quote_id, content.quote_revision,
  content.content_revision DESC;

CREATE FUNCTION validate_quote_structured_scope_items()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item text;
BEGIN
  FOREACH item IN ARRAY NEW.included_scope LOOP
    IF NOT quote_structured_text_is_valid(item, 300) THEN
      RAISE EXCEPTION 'invalid structured Quote included scope';
    END IF;
  END LOOP;
  FOREACH item IN ARRAY NEW.excluded_scope LOOP
    IF NOT quote_structured_text_is_valid(item, 300) THEN
      RAISE EXCEPTION 'invalid structured Quote excluded scope';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_structured_scope_items_guard
BEFORE INSERT ON quote_structured_content_revisions
FOR EACH ROW EXECUTE FUNCTION validate_quote_structured_scope_items();

CREATE FUNCTION validate_quote_structured_authoring_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_quote quotes%ROWTYPE;
  source_revision quote_revision_identities%ROWTYPE;
  source_head quote_revision_heads%ROWTYPE;
  current_content_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.command_id::text, 49001));
  PERFORM 1 FROM users actor
  WHERE actor.id = NEW.actor_user_id AND actor.account_state = 'ACTIVE'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned structured Quote context required';
  END IF;

  SELECT * INTO source_quote FROM quotes quote WHERE quote.id = NEW.quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'owned structured Quote context required';
  END IF;
  PERFORM 1 FROM job_invitations invitation
  WHERE invitation.id = source_quote.invitation_id FOR UPDATE;
  PERFORM 1 FROM conversations conversation
  WHERE conversation.id = source_quote.conversation_id FOR UPDATE;
  PERFORM 1 FROM quotes quote WHERE quote.id = NEW.quote_id FOR UPDATE;

  IF NOT quote_active_participant_context(
    source_quote.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', false
  ) THEN RAISE EXCEPTION 'owned structured Quote context required'; END IF;
  IF NOT quote_active_participant_context(
    source_quote.conversation_id, NEW.actor_user_id, 'CRAFTSMAN', true
  ) THEN RAISE EXCEPTION 'writable structured Quote context required'; END IF;

  SELECT * INTO source_revision FROM quote_revision_identities identity
  WHERE identity.quote_id = NEW.quote_id
    AND identity.revision = NEW.quote_revision;
  SELECT * INTO source_head FROM quote_revision_heads head
  WHERE head.quote_id = NEW.quote_id
    AND head.quote_revision = NEW.quote_revision
  FOR UPDATE;
  IF source_revision.quote_id IS NULL
      OR source_revision.authoring_mode <> 'PLATFORM_STRUCTURED'
      OR source_head.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'editable PLATFORM_STRUCTURED Quote draft required';
  END IF;

  SELECT content.content_revision INTO current_content_revision
  FROM current_quote_structured_content content
  WHERE content.quote_id = NEW.quote_id
    AND content.quote_revision = NEW.quote_revision;
  current_content_revision := coalesce(current_content_revision, 0);
  IF current_content_revision <> NEW.expected_content_revision THEN
    RAISE EXCEPTION 'structured Quote content revision is stale';
  END IF;
  NEW.resulting_content_revision := current_content_revision + 1;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_structured_authoring_commands_guard
BEFORE INSERT ON quote_structured_authoring_commands
FOR EACH ROW EXECUTE FUNCTION validate_quote_structured_authoring_command();

CREATE FUNCTION validate_quote_structured_content_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_structured_authoring_commands%ROWTYPE;
BEGIN
  SELECT * INTO source FROM quote_structured_authoring_commands command
  WHERE command.command_id = NEW.command_id FOR UPDATE;
  IF NOT FOUND OR source.quote_id <> NEW.quote_id
      OR source.quote_revision <> NEW.quote_revision THEN
    RAISE EXCEPTION 'structured Quote content requires exact command';
  END IF;
  NEW.content_revision := source.resulting_content_revision;
  NEW.changed_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_structured_content_revisions_command_guard
BEFORE INSERT ON quote_structured_content_revisions
FOR EACH ROW EXECUTE FUNCTION validate_quote_structured_content_revision();

CREATE FUNCTION reject_quote_structured_authoring_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'structured Quote authoring history is append-only'; END;
$$;

CREATE TRIGGER quote_structured_commands_append_only
BEFORE UPDATE OR DELETE ON quote_structured_authoring_commands
FOR EACH ROW EXECUTE FUNCTION reject_quote_structured_authoring_mutation();
CREATE TRIGGER quote_structured_content_append_only
BEFORE UPDATE OR DELETE ON quote_structured_content_revisions
FOR EACH ROW EXECUTE FUNCTION reject_quote_structured_authoring_mutation();

-- Replace only the PLATFORM_STRUCTURED branch. R3-017 must extend the
-- EXTERNAL_PDF branch over its own immutable PDF/summary authoring records.
CREATE OR REPLACE FUNCTION quote_revision_authoring_is_eligible(
  target_quote_id uuid,
  target_quote_revision integer,
  target_mode quote_authoring_mode
)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN target_mode = 'PLATFORM_STRUCTURED' THEN EXISTS (
      SELECT 1 FROM current_quote_structured_content content
      WHERE content.quote_id = target_quote_id
        AND content.quote_revision = target_quote_revision
        AND (content.valid_until IS NULL
          OR content.valid_until > clock_timestamp())
    )
    ELSE false
  END;
$$;

CREATE INDEX quote_structured_content_history_idx
  ON quote_structured_content_revisions (
    quote_id, quote_revision, content_revision DESC
  );

COMMENT ON TABLE quote_structured_content_revisions IS
  'Append-only authoritative PLATFORM_STRUCTURED content bound to one exact Quote revision; category amounts need not sum to the commercial total.';
COMMENT ON COLUMN quote_structured_content_revisions.deposit_percentage_basis_points IS
  'Informational prepayment percentage in integer basis points; no payment execution semantics.';
