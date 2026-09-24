-- R4-021 / D22: a dispute is a private, append-only case around one Job.
-- It is deliberately orthogonal to the Job lifecycle, commercial agreement,
-- reputation and moderation state machines.
CREATE TYPE dispute_case_state AS ENUM (
  'OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED'
);

CREATE TYPE dispute_case_category AS ENUM (
  'UNFINISHED_WORK',
  'QUALITY_DEFECT',
  'SCOPE',
  'PRICE_CHANGE_ORDER',
  'SCHEDULE',
  'MATERIAL',
  'DOCUMENTS',
  'CANCELLATION',
  'COMMUNICATION_BEHAVIOR',
  'OTHER'
);

CREATE TYPE dispute_party_role AS ENUM ('CUSTOMER', 'PRIMARY_PROVIDER');
CREATE TYPE dispute_case_transition_action AS ENUM ('OPEN');
CREATE TYPE dispute_statement_kind AS ENUM ('STATEMENT', 'ADDENDUM');
CREATE TYPE dispute_evidence_source AS ENUM (
  'NEW_UPLOAD', 'EXISTING_JOB_EVIDENCE'
);

CREATE FUNCTION dispute_actor_role(target_job_id uuid, actor_id uuid)
RETURNS dispute_party_role LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN customer.owner_user_id = actor.id THEN 'CUSTOMER'::dispute_party_role
    WHEN provider.owner_user_id = actor.id
      THEN 'PRIMARY_PROVIDER'::dispute_party_role
    ELSE NULL
  END
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  JOIN users actor ON actor.id = actor_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials credential ON credential.user_id = actor.id
    AND credential.email_verified_at IS NOT NULL
    AND credential.phone_verified_at IS NOT NULL
  WHERE job.id = target_job_id
    AND (customer.owner_user_id = actor.id
      OR provider.owner_user_id = actor.id)
$$;

CREATE TABLE dispute_cases (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  opened_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_by_role dispute_party_role NOT NULL,
  category dispute_case_category NOT NULL,
  description text NOT NULL,
  desired_resolution text NOT NULL,
  command_intent_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dispute_case_intent_hash CHECK (
    command_intent_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT dispute_case_description_bounded CHECK (
    description = btrim(description)
    AND length(description) BETWEEN 10 AND 4000
    AND description !~ '[[:cntrl:]]'
  ),
  CONSTRAINT dispute_case_resolution_bounded CHECK (
    desired_resolution = btrim(desired_resolution)
    AND length(desired_resolution) BETWEEN 1 AND 2000
    AND desired_resolution !~ '[[:cntrl:]]'
  )
);
CREATE INDEX dispute_cases_job_created_idx
  ON dispute_cases (job_id, created_at DESC, id DESC);

CREATE TABLE dispute_case_state_events (
  event_id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  action dispute_case_transition_action NOT NULL,
  from_state dispute_case_state,
  to_state dispute_case_state NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_role dispute_party_role NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dispute_id, event_sequence),
  CONSTRAINT dispute_state_reason_bounded CHECK (
    reason IS NULL OR (
      reason = btrim(reason)
      AND length(reason) BETWEEN 1 AND 2000
      AND reason !~ '[[:cntrl:]]'
    )
  )
);

CREATE VIEW current_dispute_cases
WITH (security_invoker = true)
AS
SELECT dispute.id, dispute.job_id, dispute.opened_by_user_id,
  dispute.opened_by_role, dispute.category, dispute.description,
  dispute.desired_resolution, dispute.created_at,
  latest.event_id AS state_event_id,
  latest.event_sequence AS state_revision,
  latest.to_state AS state,
  latest.occurred_at AS state_changed_at
FROM dispute_cases dispute
JOIN LATERAL (
  SELECT event.event_id, event.event_sequence, event.to_state,
    event.occurred_at
  FROM dispute_case_state_events event
  WHERE event.dispute_id = dispute.id
  ORDER BY event.event_sequence DESC
  LIMIT 1
) latest ON true;

CREATE FUNCTION validate_dispute_case()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_role dispute_party_role;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'accepted Job required for dispute'; END IF;
  actor_role := dispute_actor_role(NEW.job_id, NEW.opened_by_user_id);
  IF actor_role IS NULL OR actor_role IS DISTINCT FROM NEW.opened_by_role THEN
    RAISE EXCEPTION 'contractual Job party required to open dispute';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM current_job_states state
    WHERE state.job_id = NEW.job_id
      AND state.state IN ('CONFIRMED', 'IN_PROGRESS',
        'COMPLETION_REQUESTED', 'COMPLETED', 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'eligible accepted Job state required for dispute';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_case_validate
BEFORE INSERT ON dispute_cases
FOR EACH ROW EXECUTE FUNCTION validate_dispute_case();

CREATE FUNCTION validate_dispute_case_state_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dispute dispute_cases%ROWTYPE;
BEGIN
  SELECT * INTO dispute FROM dispute_cases
  WHERE id = NEW.dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute case required'; END IF;
  IF pg_trigger_depth() < 2
      OR NEW.event_id IS DISTINCT FROM dispute.id
      OR NEW.event_sequence <> 1
      OR NEW.action <> 'OPEN'
      OR NEW.from_state IS NOT NULL
      OR NEW.to_state <> 'OPEN'
      OR NEW.actor_user_id IS DISTINCT FROM dispute.opened_by_user_id
      OR NEW.actor_role IS DISTINCT FROM dispute.opened_by_role
      OR NEW.reason IS NOT NULL
      OR NEW.occurred_at IS DISTINCT FROM dispute.created_at THEN
    RAISE EXCEPTION 'initial dispute state must derive from case creation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_case_state_event_validate
BEFORE INSERT ON dispute_case_state_events
FOR EACH ROW EXECUTE FUNCTION validate_dispute_case_state_event();

CREATE FUNCTION initialize_dispute_case()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
BEGIN
  INSERT INTO dispute_case_state_events (
    event_id, dispute_id, event_sequence, action, from_state, to_state,
    actor_user_id, actor_role, reason, occurred_at
  ) VALUES (
    NEW.id, NEW.id, 1, 'OPEN', NULL, 'OPEN', NEW.opened_by_user_id,
    NEW.opened_by_role, NULL, NEW.created_at
  );

  SELECT CASE WHEN NEW.opened_by_role = 'CUSTOMER'
      THEN provider.owner_user_id ELSE customer.owner_user_id END
    INTO recipient_id
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider
    ON provider.id = job.primary_craftsman_profile_id
  WHERE job.id = NEW.job_id;
  IF recipient_id IS NULL OR recipient_id IS NOT DISTINCT FROM NEW.opened_by_user_id THEN
    RAISE EXCEPTION 'distinct dispute counterparty required';
  END IF;
  PERFORM insert_exact_notification_outbox_event(
    'dispute:' || NEW.id::text || ':opened:' || recipient_id::text,
    'job.dispute.opened', NEW.created_at,
    'DISPUTE_CASE', NEW.id::text,
    jsonb_build_object(
      'recipient_user_id', recipient_id::text,
      'job_id', NEW.job_id::text,
      'dispute_id', NEW.id::text
    ),
    'job.dispute.opened', NEW.id::text, NEW.created_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER dispute_case_initialize
AFTER INSERT ON dispute_cases
FOR EACH ROW EXECUTE FUNCTION initialize_dispute_case();

CREATE TABLE dispute_case_statements (
  id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role dispute_party_role NOT NULL,
  kind dispute_statement_kind NOT NULL,
  body text NOT NULL,
  command_intent_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dispute_statement_intent_hash CHECK (
    command_intent_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT dispute_statement_body_bounded CHECK (
    body = btrim(body)
    AND length(body) BETWEEN 1 AND 4000
    AND body !~ '[[:cntrl:]]'
  )
);
CREATE INDEX dispute_case_statements_case_idx
  ON dispute_case_statements (dispute_id, created_at, id);

CREATE TABLE dispute_case_evidence (
  id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL REFERENCES dispute_cases(id) ON DELETE RESTRICT,
  submitted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_by_role dispute_party_role NOT NULL,
  source dispute_evidence_source NOT NULL,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  description text NOT NULL,
  command_intent_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dispute_id, media_asset_id),
  CONSTRAINT dispute_evidence_intent_hash CHECK (
    command_intent_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT dispute_evidence_description_bounded CHECK (
    description = btrim(description)
    AND length(description) BETWEEN 1 AND 1000
    AND description !~ '[[:cntrl:]]'
  )
);
CREATE INDEX dispute_case_evidence_case_idx
  ON dispute_case_evidence (dispute_id, created_at, id);
CREATE INDEX dispute_case_evidence_media_idx
  ON dispute_case_evidence (media_asset_id);

CREATE FUNCTION dispute_case_accepts_party_content(target_dispute_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT state IN ('OPEN', 'WAITING_FOR_PARTY', 'UNDER_REVIEW')
  FROM current_dispute_cases WHERE id = target_dispute_id
$$;

CREATE FUNCTION validate_dispute_case_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid;
DECLARE expected_role dispute_party_role;
BEGIN
  SELECT dispute.job_id INTO target_job_id
  FROM dispute_cases dispute WHERE dispute.id = NEW.dispute_id FOR UPDATE;
  expected_role := dispute_actor_role(target_job_id, NEW.author_user_id);
  IF target_job_id IS NULL
      OR expected_role IS NULL
      OR expected_role IS DISTINCT FROM NEW.author_role
      OR NOT dispute_case_accepts_party_content(NEW.dispute_id) THEN
    RAISE EXCEPTION 'active dispute contractual party required';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_case_statement_validate
BEFORE INSERT ON dispute_case_statements
FOR EACH ROW EXECUTE FUNCTION validate_dispute_case_statement();

CREATE FUNCTION validate_dispute_case_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid;
DECLARE expected_role dispute_party_role;
DECLARE asset media_assets%ROWTYPE;
BEGIN
  SELECT dispute.job_id INTO target_job_id
  FROM dispute_cases dispute WHERE dispute.id = NEW.dispute_id FOR UPDATE;
  expected_role := dispute_actor_role(target_job_id, NEW.submitted_by_user_id);
  IF target_job_id IS NULL
      OR expected_role IS NULL
      OR expected_role IS DISTINCT FROM NEW.submitted_by_role
      OR NOT dispute_case_accepts_party_content(NEW.dispute_id) THEN
    RAISE EXCEPTION 'active dispute contractual party required';
  END IF;

  SELECT * INTO asset FROM media_assets
  WHERE id = NEW.media_asset_id FOR SHARE;
  IF NOT FOUND OR asset.status <> 'READY'
      OR (asset.kind = 'DOCUMENT'
        AND asset.malware_scan_verdict IS DISTINCT FROM 'CLEAN')
      OR NOT EXISTS (
        SELECT 1 FROM media_asset_storage_objects canonical
        WHERE canonical.media_asset_id = asset.id
          AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private'
          AND canonical.revoked_at IS NULL
          AND ((asset.kind = 'IMAGE'
              AND canonical.content_type = 'image/webp')
            OR (asset.kind = 'DOCUMENT'
              AND canonical.content_type = 'application/pdf'
              AND canonical.content_sha256 = asset.document_content_sha256))
      ) THEN
    RAISE EXCEPTION 'READY private clean dispute evidence required';
  END IF;

  IF NEW.source = 'NEW_UPLOAD' THEN
    IF asset.owner_user_id IS DISTINCT FROM NEW.submitted_by_user_id
        OR asset.uploaded_by_user_id IS DISTINCT FROM NEW.submitted_by_user_id
        OR asset.purpose <> 'DISPUTE_EVIDENCE'
        OR asset.provenance_entity_type <> 'DISPUTE_CASE'
        OR asset.provenance_entity_id IS DISTINCT FROM NEW.dispute_id
        OR asset.provenance_entity_revision IS NOT NULL THEN
      RAISE EXCEPTION 'purpose-bound dispute upload required';
    END IF;
  ELSIF NEW.source = 'EXISTING_JOB_EVIDENCE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM job_conversation_media media
      WHERE media.job_id = target_job_id
        AND media.media_asset_id = NEW.media_asset_id
    ) THEN
      RAISE EXCEPTION 'same-Job existing evidence required';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported dispute evidence source';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_case_evidence_validate
BEFORE INSERT ON dispute_case_evidence
FOR EACH ROW EXECUTE FUNCTION validate_dispute_case_evidence();

CREATE FUNCTION reject_dispute_case_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Dispute case history is immutable'; END;
$$;
CREATE TRIGGER dispute_case_immutable
BEFORE UPDATE OR DELETE ON dispute_cases
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_case_state_event_immutable
BEFORE UPDATE OR DELETE ON dispute_case_state_events
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_case_statement_immutable
BEFORE UPDATE OR DELETE ON dispute_case_statements
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();
CREATE TRIGGER dispute_case_evidence_immutable
BEFORE UPDATE OR DELETE ON dispute_case_evidence
FOR EACH ROW EXECUTE FUNCTION reject_dispute_case_mutation();

COMMENT ON TABLE dispute_cases IS
  'Private D22 contractual-party case linked to one Job; never a Job state, payment fact, reputation penalty or legal verdict.';
COMMENT ON TABLE dispute_case_statements IS
  'Append-only party statements and addenda; corrections create another record.';
COMMENT ON TABLE dispute_case_evidence IS
  'Append-only case evidence using purpose-bound uploads or exact same-Job media provenance.';
