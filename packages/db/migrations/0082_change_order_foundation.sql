-- D19: one Job, immutable commercial revisions, bilateral exact-revision assent.
-- This is the authoritative amendment ledger; R4-013 derives current terms.
CREATE TYPE change_order_side AS ENUM ('CUSTOMER', 'PRIMARY_PROVIDER');
CREATE TYPE change_order_price_impact AS ENUM ('NONE', 'FIXED_DELTA', 'ESTIMATE_DELTA', 'RANGE_DELTA');
CREATE TYPE change_order_schedule_impact AS ENUM ('NONE', 'DAYS', 'DATE', 'RANGE');
CREATE TYPE change_order_document_mode AS ENUM ('STRUCTURED', 'EXTERNAL_PDF');
CREATE TYPE change_order_action AS ENUM ('PROPOSE', 'APPROVE', 'REJECT', 'WITHDRAW', 'SUPERSEDE');

CREATE FUNCTION change_order_lines_valid(value text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NOT NULL AND cardinality(value) BETWEEN 0 AND 50
    AND NOT EXISTS (SELECT 1 FROM unnest(value) line
      WHERE line IS NULL OR NOT quote_structured_text_is_valid(line, 500));
$$;

CREATE TABLE change_orders (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by_side change_order_side NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, id)
);
CREATE INDEX change_orders_job_page_idx ON change_orders (job_id, created_at DESC, id DESC);

CREATE TABLE change_order_revisions (
  id uuid PRIMARY KEY,
  change_order_id uuid NOT NULL REFERENCES change_orders(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  creation_command_id uuid NOT NULL UNIQUE,
  command_intent_sha256 char(64) NOT NULL CHECK (command_intent_sha256 ~ '^[0-9a-f]{64}$'),
  creation_state text NOT NULL CHECK (creation_state IN ('DRAFT', 'PROPOSED')),
  authored_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authored_side change_order_side NOT NULL,
  title text NOT NULL CHECK (quote_structured_text_is_valid(title, 160)),
  reason text NOT NULL CHECK (quote_structured_text_is_valid(reason, 500)),
  change_description text NOT NULL CHECK (quote_structured_text_is_valid(change_description, 4000)),
  scope_added text[] NOT NULL CHECK (change_order_lines_valid(scope_added)),
  scope_removed text[] NOT NULL CHECK (change_order_lines_valid(scope_removed)),
  scope_changed text[] NOT NULL CHECK (change_order_lines_valid(scope_changed)),
  price_impact_mode change_order_price_impact NOT NULL,
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  delta_amount_cents bigint,
  range_minimum_delta_cents bigint,
  range_maximum_delta_cents bigint,
  price_basis text CHECK (price_basis IS NULL OR quote_structured_text_is_valid(price_basis, 500)),
  vat_status structured_quote_vat_status,
  schedule_impact_mode change_order_schedule_impact NOT NULL,
  schedule_delta_days integer,
  schedule_new_date date,
  schedule_range_start date,
  schedule_range_end date,
  material_responsibility structured_quote_material_responsibility,
  warranty_change text CHECK (warranty_change IS NULL OR quote_structured_text_is_valid(warranty_change, 1000)),
  other_condition_change text CHECK (other_condition_change IS NULL OR quote_structured_text_is_valid(other_condition_change, 1000)),
  affected_milestone_ids uuid[] NOT NULL DEFAULT '{}',
  document_mode change_order_document_mode NOT NULL DEFAULT 'STRUCTURED',
  pdf_media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  pdf_content_sha256 char(64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (change_order_id, revision_number),
  UNIQUE (change_order_id, id),
  CONSTRAINT change_order_price_shape CHECK (
    (price_impact_mode = 'NONE' AND delta_amount_cents IS NULL
      AND range_minimum_delta_cents IS NULL AND range_maximum_delta_cents IS NULL
      AND price_basis IS NULL AND vat_status IS NULL)
    OR (price_impact_mode = 'FIXED_DELTA' AND delta_amount_cents IS NOT NULL
      AND delta_amount_cents BETWEEN -1000000000000 AND 1000000000000
      AND delta_amount_cents <> 0 AND range_minimum_delta_cents IS NULL
      AND range_maximum_delta_cents IS NULL AND price_basis IS NULL AND vat_status IS NOT NULL)
    OR (price_impact_mode = 'ESTIMATE_DELTA' AND delta_amount_cents IS NOT NULL
      AND delta_amount_cents BETWEEN -1000000000000 AND 1000000000000
      AND delta_amount_cents <> 0 AND range_minimum_delta_cents IS NULL
      AND range_maximum_delta_cents IS NULL AND price_basis IS NOT NULL AND vat_status IS NOT NULL)
    OR (price_impact_mode = 'RANGE_DELTA' AND delta_amount_cents IS NULL
      AND range_minimum_delta_cents IS NOT NULL AND range_maximum_delta_cents IS NOT NULL
      AND range_minimum_delta_cents BETWEEN -1000000000000 AND 1000000000000
      AND range_maximum_delta_cents BETWEEN -1000000000000 AND 1000000000000
      AND range_minimum_delta_cents <= range_maximum_delta_cents
      AND (range_minimum_delta_cents <> 0 OR range_maximum_delta_cents <> 0)
      AND price_basis IS NOT NULL AND vat_status IS NOT NULL)
  ),
  CONSTRAINT change_order_schedule_shape CHECK (
    (schedule_impact_mode = 'NONE' AND schedule_delta_days IS NULL
      AND schedule_new_date IS NULL AND schedule_range_start IS NULL AND schedule_range_end IS NULL)
    OR (schedule_impact_mode = 'DAYS' AND schedule_delta_days IS NOT NULL
      AND schedule_delta_days BETWEEN -3650 AND 3650
      AND schedule_delta_days <> 0 AND schedule_new_date IS NULL
      AND schedule_range_start IS NULL AND schedule_range_end IS NULL)
    OR (schedule_impact_mode = 'DATE' AND schedule_delta_days IS NULL AND schedule_new_date IS NOT NULL
      AND schedule_range_start IS NULL AND schedule_range_end IS NULL)
    OR (schedule_impact_mode = 'RANGE' AND schedule_delta_days IS NULL AND schedule_new_date IS NULL
      AND schedule_range_start IS NOT NULL AND schedule_range_end IS NOT NULL
      AND schedule_range_start <= schedule_range_end)
  ),
  CONSTRAINT change_order_material_change CHECK (
    cardinality(scope_added) + cardinality(scope_removed) + cardinality(scope_changed) > 0
    OR price_impact_mode <> 'NONE' OR schedule_impact_mode <> 'NONE'
    OR material_responsibility IS NOT NULL OR warranty_change IS NOT NULL
    OR other_condition_change IS NOT NULL
  ),
  CONSTRAINT change_order_milestone_count CHECK (cardinality(affected_milestone_ids) <= 50),
  CONSTRAINT change_order_pdf_pair CHECK (
    (document_mode = 'STRUCTURED' AND pdf_media_asset_id IS NULL AND pdf_content_sha256 IS NULL)
    OR (document_mode = 'EXTERNAL_PDF' AND pdf_media_asset_id IS NOT NULL
      AND pdf_content_sha256 IS NOT NULL
      AND pdf_content_sha256 ~ '^[0-9a-f]{64}$')
  )
);
CREATE INDEX change_order_revisions_order_idx ON change_order_revisions (change_order_id, revision_number DESC);

CREATE TABLE change_order_revision_actions (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES change_order_revisions(id) ON DELETE RESTRICT,
  action_sequence integer NOT NULL CHECK (action_sequence > 0),
  action change_order_action NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_intent_sha256 char(64) NOT NULL CHECK (command_intent_sha256 ~ '^[0-9a-f]{64}$'),
  superseded_by_revision_id uuid REFERENCES change_order_revisions(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT change_order_supersede_pair CHECK ((action = 'SUPERSEDE') = (superseded_by_revision_id IS NOT NULL)),
  UNIQUE (revision_id, action_sequence),
  UNIQUE (revision_id, action)
);
CREATE INDEX change_order_actions_revision_idx ON change_order_revision_actions (revision_id, action_sequence DESC);

CREATE VIEW current_change_order_revision_states AS
SELECT revision.id AS revision_id, revision.change_order_id, revision.revision_number,
  revision.authored_by_user_id, revision.authored_side,
  COALESCE(CASE latest.action
    WHEN 'PROPOSE' THEN 'PROPOSED'
    WHEN 'APPROVE' THEN 'APPROVED'
    WHEN 'REJECT' THEN 'REJECTED'
    WHEN 'WITHDRAW' THEN 'WITHDRAWN'
    WHEN 'SUPERSEDE' THEN 'SUPERSEDED'
  END, 'DRAFT') AS state,
  latest.id AS latest_action_id, latest.occurred_at AS state_changed_at
FROM change_order_revisions revision
LEFT JOIN LATERAL (
  SELECT id, action, occurred_at FROM change_order_revision_actions action
  WHERE action.revision_id = revision.id ORDER BY action_sequence DESC LIMIT 1
) latest ON true;

CREATE VIEW current_change_orders AS
SELECT source.id, source.job_id, source.created_by_user_id, source.created_by_side,
  source.created_at, revision.id AS revision_id, revision.revision_number,
  state.state, state.state_changed_at
FROM change_orders source
JOIN LATERAL (
  SELECT id, revision_number FROM change_order_revisions revision
  WHERE revision.change_order_id = source.id
  ORDER BY revision_number DESC LIMIT 1
) revision ON true
JOIN current_change_order_revision_states state ON state.revision_id = revision.id;

CREATE FUNCTION change_order_actor_side(target_job_id uuid, target_actor_id uuid)
RETURNS change_order_side LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN customer.owner_user_id = actor.id THEN 'CUSTOMER'::change_order_side
    WHEN provider.owner_user_id = actor.id THEN 'PRIMARY_PROVIDER'::change_order_side
    ELSE NULL END
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN users actor ON actor.id = target_actor_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials credentials ON credentials.user_id = actor.id
    AND credentials.email_verified_at IS NOT NULL
    AND credentials.phone_verified_at IS NOT NULL
  WHERE job.id = target_job_id;
$$;

CREATE FUNCTION require_change_order_first_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM change_order_revisions revision
    WHERE revision.change_order_id = NEW.id AND revision.revision_number = 1
      AND revision.creation_command_id = NEW.id
      AND revision.authored_by_user_id = NEW.created_by_user_id
  ) THEN RAISE EXCEPTION 'Change order requires first draft revision'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_change_order_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state job_state; side change_order_side;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirmed Job required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51012));
  PERFORM 1 FROM users WHERE id = NEW.created_by_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.created_by_user_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = NEW.job_id;
  side := change_order_actor_side(NEW.job_id, NEW.created_by_user_id);
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR side IS NULL THEN RAISE EXCEPTION 'active contracting Job party required'; END IF;
  NEW.created_by_side := side;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION require_change_order_revision_predecessor()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_state text; new_state text;
BEGIN
  IF NEW.revision_number <= 1 THEN RETURN NULL; END IF;
  SELECT state INTO prior_state FROM current_change_order_revision_states
    WHERE change_order_id = NEW.change_order_id AND revision_number = NEW.revision_number - 1;
  SELECT state INTO new_state FROM current_change_order_revision_states
    WHERE revision_id = NEW.id;
  IF prior_state IS DISTINCT FROM 'SUPERSEDED'
    OR NOT EXISTS (SELECT 1 FROM change_order_revision_actions action
      JOIN change_order_revisions prior ON prior.id = action.revision_id
      WHERE prior.change_order_id = NEW.change_order_id
        AND prior.revision_number = NEW.revision_number - 1
        AND action.action = 'SUPERSEDE'
        AND action.superseded_by_revision_id = NEW.id)
    OR (NEW.authored_side IS DISTINCT FROM (
      SELECT authored_side FROM change_order_revisions
      WHERE change_order_id = NEW.change_order_id AND revision_number = NEW.revision_number - 1)
      AND new_state IS DISTINCT FROM 'PROPOSED') THEN
    RAISE EXCEPTION 'new Change-order revision must explicitly supersede prior offer';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_change_order_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid; current_state job_state; side change_order_side;
  prior_number integer; prior_side change_order_side; prior_state text;
  pdf_hash char(64);
BEGIN
  SELECT job_id INTO target_job_id FROM change_orders WHERE id = NEW.change_order_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'Change order required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.creation_command_id::text, 51012));
  PERFORM 1 FROM users WHERE id = NEW.authored_by_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.authored_by_user_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = target_job_id;
  side := change_order_actor_side(target_job_id, NEW.authored_by_user_id);
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR side IS NULL THEN RAISE EXCEPTION 'active contracting Job party required'; END IF;
  SELECT max(revision_number) INTO prior_number FROM change_order_revisions
    WHERE change_order_id = NEW.change_order_id;
  IF NEW.revision_number IS DISTINCT FROM coalesce(prior_number, 0) + 1 THEN
    RAISE EXCEPTION 'next Change-order revision required';
  END IF;
  IF prior_number IS NULL THEN
    IF NEW.creation_state <> 'DRAFT'
      OR NEW.creation_command_id IS DISTINCT FROM NEW.change_order_id
      OR NEW.authored_by_user_id IS DISTINCT FROM (
        SELECT created_by_user_id FROM change_orders WHERE id = NEW.change_order_id) THEN
      RAISE EXCEPTION 'first revision must match Change-order creator';
    END IF;
  ELSE
    SELECT authored_side, state INTO prior_side, prior_state
      FROM current_change_order_revision_states
      WHERE change_order_id = NEW.change_order_id AND revision_number = prior_number;
    IF prior_state NOT IN ('DRAFT', 'PROPOSED')
      OR (prior_state = 'DRAFT' AND (side IS DISTINCT FROM prior_side OR NEW.creation_state <> 'DRAFT'))
      OR (prior_state = 'PROPOSED' AND (side IS NOT DISTINCT FROM prior_side OR NEW.creation_state <> 'PROPOSED')) THEN
      RAISE EXCEPTION 'terminal Change-order revision cannot be replaced';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.affected_milestone_ids) id WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(NEW.affected_milestone_ids) id)
      <> cardinality(NEW.affected_milestone_ids)
    OR EXISTS (SELECT 1 FROM unnest(NEW.affected_milestone_ids) id
      WHERE NOT EXISTS (SELECT 1 FROM job_milestones milestone
        WHERE milestone.id = id AND milestone.job_id = target_job_id)) THEN
    RAISE EXCEPTION 'exact-Job unique affected milestone IDs required';
  END IF;
  IF NEW.document_mode = 'EXTERNAL_PDF' THEN
    IF side <> 'PRIMARY_PROVIDER' THEN
      RAISE EXCEPTION 'provider-owned Change-order PDF required';
    END IF;
    SELECT asset.document_content_sha256 INTO pdf_hash
    FROM media_assets asset
    JOIN media_asset_storage_objects canonical ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL' AND canonical.storage_area = 'private'
      AND canonical.content_type = 'application/pdf' AND canonical.revoked_at IS NULL
      AND canonical.content_sha256 = asset.document_content_sha256
    WHERE asset.id = NEW.pdf_media_asset_id AND asset.status = 'READY'
      AND asset.kind = 'DOCUMENT' AND asset.purpose = 'CHANGE_ORDER_DOCUMENT'
      AND asset.malware_scan_verdict = 'CLEAN'
      AND asset.provenance_entity_type = 'CHANGE_ORDER_REVISION'
      AND asset.provenance_entity_id = NEW.id
      AND asset.provenance_entity_revision = NEW.revision_number
      AND asset.uploaded_by_user_id = NEW.authored_by_user_id;
    IF pdf_hash IS NULL THEN RAISE EXCEPTION 'READY private exact-revision PDF required'; END IF;
    NEW.pdf_content_sha256 := pdf_hash;
  ELSE
    NEW.pdf_content_sha256 := NULL;
  END IF;
  NEW.authored_side := side;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_change_order_action()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source change_order_revisions%ROWTYPE; target_job_id uuid;
  current_state job_state; side change_order_side; revision_state text;
  latest_number integer; next_sequence integer; successor change_order_revisions%ROWTYPE;
  successor_state text;
BEGIN
  SELECT * INTO source FROM change_order_revisions WHERE id = NEW.revision_id;
  IF source.id IS NULL THEN RAISE EXCEPTION 'Change-order revision required'; END IF;
  SELECT job_id INTO target_job_id FROM change_orders WHERE id = source.change_order_id;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51012));
  PERFORM 1 FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = NEW.actor_user_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = target_job_id;
  side := change_order_actor_side(target_job_id, NEW.actor_user_id);
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR side IS NULL THEN RAISE EXCEPTION 'active contracting Job party required'; END IF;
  SELECT state INTO revision_state FROM current_change_order_revision_states
    WHERE revision_id = source.id;
  SELECT max(revision_number) INTO latest_number FROM change_order_revisions
    WHERE change_order_id = source.change_order_id;
  SELECT coalesce(max(action_sequence), 0) + 1 INTO next_sequence
    FROM change_order_revision_actions WHERE revision_id = source.id;
  IF NEW.action = 'PROPOSE' THEN
    IF revision_state <> 'DRAFT' OR source.revision_number <> latest_number
      OR side <> source.authored_side THEN
      RAISE EXCEPTION 'only author side may propose current DRAFT';
    END IF;
  ELSIF NEW.action IN ('APPROVE', 'REJECT') THEN
    IF revision_state <> 'PROPOSED' OR source.revision_number <> latest_number
      OR side = source.authored_side THEN
      RAISE EXCEPTION 'only opposite party may decide exact current proposal';
    END IF;
  ELSIF NEW.action = 'WITHDRAW' THEN
    IF revision_state <> 'PROPOSED' OR source.revision_number <> latest_number
      OR side <> source.authored_side THEN
      RAISE EXCEPTION 'only proposer may withdraw current proposal';
    END IF;
  ELSE
    SELECT * INTO successor FROM change_order_revisions WHERE id = NEW.superseded_by_revision_id;
    SELECT state INTO successor_state FROM current_change_order_revision_states
      WHERE revision_id = successor.id;
    IF revision_state NOT IN ('DRAFT', 'PROPOSED')
      OR successor.id IS NULL OR successor.change_order_id <> source.change_order_id
      OR successor.revision_number <> source.revision_number + 1
      OR side <> successor.authored_side
      OR (revision_state = 'DRAFT' AND (side <> source.authored_side OR successor_state <> 'DRAFT'))
      OR (revision_state = 'PROPOSED' AND successor_state <> 'PROPOSED') THEN
      RAISE EXCEPTION 'invalid explicit Change-order supersession';
    END IF;
  END IF;
  NEW.action_sequence := next_sequence;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_change_order_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Change-order history is immutable'; END;
$$;

CREATE FUNCTION notify_change_order_action()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source change_order_revisions%ROWTYPE;
  target_job_id uuid;
  customer_user_id uuid;
  provider_user_id uuid;
  recipient_id uuid;
  candidate_name text;
  candidate_payload jsonb;
BEGIN
  IF NEW.action = 'SUPERSEDE' THEN RETURN NULL; END IF;
  SELECT * INTO source FROM change_order_revisions WHERE id = NEW.revision_id;
  SELECT job.id, customer.owner_user_id, provider.owner_user_id
    INTO target_job_id, customer_user_id, provider_user_id
  FROM change_orders order_identity
  JOIN jobs job ON job.id = order_identity.job_id
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  WHERE order_identity.id = source.change_order_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'Change-order notification parties missing'; END IF;
  IF NEW.action = 'PROPOSE' THEN
    candidate_name := CASE WHEN EXISTS (
      SELECT 1 FROM change_order_revisions earlier
      JOIN change_order_revision_actions prior_action ON prior_action.revision_id = earlier.id
        AND prior_action.action = 'PROPOSE'
      WHERE earlier.change_order_id = source.change_order_id
        AND earlier.revision_number < source.revision_number)
      THEN 'job.change_order.counterproposed' ELSE 'job.change_order.proposed' END;
    recipient_id := CASE WHEN source.authored_side = 'CUSTOMER'
      THEN provider_user_id ELSE customer_user_id END;
  ELSIF NEW.action = 'REJECT' THEN
    candidate_name := 'job.change_order.rejected';
    recipient_id := source.authored_by_user_id;
  ELSIF NEW.action = 'WITHDRAW' THEN
    candidate_name := 'job.change_order.withdrawn';
    recipient_id := CASE WHEN source.authored_side = 'CUSTOMER'
      THEN provider_user_id ELSE customer_user_id END;
  ELSE
    candidate_name := 'job.change_order.approved';
    recipient_id := NULL;
  END IF;
  candidate_payload := jsonb_build_object(
    'job_id', target_job_id::text,
    'change_order_id', source.change_order_id::text,
    'revision_id', source.id::text,
    'revision_number', source.revision_number
  );
  IF NEW.action = 'APPROVE' THEN
    PERFORM insert_exact_notification_outbox_event(
      'job.change_order.' || NEW.id::text || '.customer', candidate_name,
      NEW.occurred_at, 'CHANGE_ORDER_REVISION', source.id::text,
      candidate_payload || jsonb_build_object('recipient_user_id', customer_user_id::text),
      'job.change_order', NEW.id::text, NEW.occurred_at);
    PERFORM insert_exact_notification_outbox_event(
      'job.change_order.' || NEW.id::text || '.provider', candidate_name,
      NEW.occurred_at, 'CHANGE_ORDER_REVISION', source.id::text,
      candidate_payload || jsonb_build_object('recipient_user_id', provider_user_id::text),
      'job.change_order', NEW.id::text, NEW.occurred_at);
  ELSE
    PERFORM insert_exact_notification_outbox_event(
      'job.change_order.' || NEW.id::text, candidate_name,
      NEW.occurred_at, 'CHANGE_ORDER_REVISION', source.id::text,
      candidate_payload || jsonb_build_object('recipient_user_id', recipient_id::text),
      'job.change_order', NEW.id::text, NEW.occurred_at);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER change_order_identity_validate BEFORE INSERT ON change_orders
  FOR EACH ROW EXECUTE FUNCTION validate_change_order_identity();
CREATE CONSTRAINT TRIGGER change_order_first_revision_required
  AFTER INSERT ON change_orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_change_order_first_revision();
CREATE TRIGGER change_order_revision_validate BEFORE INSERT ON change_order_revisions
  FOR EACH ROW EXECUTE FUNCTION validate_change_order_revision();
CREATE CONSTRAINT TRIGGER change_order_revision_predecessor_required
  AFTER INSERT ON change_order_revisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_change_order_revision_predecessor();
CREATE TRIGGER change_order_action_validate BEFORE INSERT ON change_order_revision_actions
  FOR EACH ROW EXECUTE FUNCTION validate_change_order_action();
CREATE TRIGGER change_order_action_notify AFTER INSERT ON change_order_revision_actions
  FOR EACH ROW EXECUTE FUNCTION notify_change_order_action();
CREATE TRIGGER change_order_identity_immutable BEFORE UPDATE OR DELETE ON change_orders
  FOR EACH ROW EXECUTE FUNCTION reject_change_order_mutation();
CREATE TRIGGER change_order_revision_immutable BEFORE UPDATE OR DELETE ON change_order_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_change_order_mutation();
CREATE TRIGGER change_order_action_immutable BEFORE UPDATE OR DELETE ON change_order_revision_actions
  FOR EACH ROW EXECUTE FUNCTION reject_change_order_mutation();

COMMENT ON TABLE change_order_revisions IS 'Immutable typed commercial amendments; no mutation of accepted base agreement.';
COMMENT ON TABLE change_order_revision_actions IS 'Append-only exact-revision bilateral assent and decision history.';
