CREATE TYPE privacy_policy_kind AS ENUM (
  'PRIVACY_NOTICE',
  'TERMS_OF_SERVICE',
  'OPTIONAL_CONSENT_TEXT',
  'PURPOSE_LEGAL_BASIS_REGISTER',
  'DATA_PROCESSING_INVENTORY'
);

CREATE TYPE privacy_review_state AS ENUM ('UNRESOLVED', 'APPROVED');

CREATE TYPE privacy_optional_consent_purpose AS ENUM (
  'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION',
  'NON_ESSENTIAL_ANALYTICS',
  'MARKETING_EMAIL'
);

CREATE TYPE privacy_consent_action AS ENUM ('GRANTED', 'WITHDRAWN');

CREATE TYPE privacy_retention_category AS ENUM (
  'ACCOUNT_CORE',
  'ABANDONED_DRAFT',
  'PRE_JOB_CONVERSATION',
  'COMMERCIAL_JOB_RECORD',
  'PRIVATE_JOB_MEDIA',
  'PUBLIC_PORTFOLIO_MEDIA',
  'CREDENTIAL_EVIDENCE',
  'REJECTED_CREDENTIAL',
  'MALWARE_QUARANTINE',
  'DISPUTE_EVIDENCE',
  'MODERATION_SECURITY',
  'RISK_FLAG',
  'APPLICATION_LOG',
  'NOTIFICATION_DELIVERY',
  'AUDIT_EVENT',
  'PRIVACY_REQUEST_CASE',
  'BACKUP'
);

CREATE TYPE privacy_retention_launch_state AS ENUM ('BLOCKED', 'READY');

CREATE TYPE privacy_request_type AS ENUM (
  'ACCESS',
  'RECTIFICATION',
  'ERASURE',
  'RESTRICTION',
  'PORTABILITY',
  'OBJECTION',
  'ACCOUNT_CLOSURE'
);

CREATE TYPE privacy_request_state AS ENUM (
  'RECEIVED',
  'IDENTITY_VERIFICATION_PENDING',
  'VERIFIED',
  'IN_REVIEW',
  'ACTION_REQUIRED',
  'COMPLETED',
  'REJECTED'
);

CREATE TABLE privacy_policy_versions (
  policy_version_id uuid PRIMARY KEY,
  policy_kind privacy_policy_kind NOT NULL,
  optional_consent_purpose privacy_optional_consent_purpose,
  version_label text NOT NULL,
  content_sha256 char(64) NOT NULL,
  review_state privacy_review_state NOT NULL,
  effective_at timestamptz,
  supersedes_policy_version_id uuid
    REFERENCES privacy_policy_versions(policy_version_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT privacy_policy_versions_label_safe CHECK (
    version_label ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  CONSTRAINT privacy_policy_versions_hash_safe CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT privacy_policy_versions_review_consistent CHECK (
    (review_state = 'UNRESOLVED' AND effective_at IS NULL)
    OR (review_state = 'APPROVED' AND effective_at IS NOT NULL)
  ),
  CONSTRAINT privacy_policy_versions_consent_purpose_consistent CHECK (
    (
      policy_kind = 'OPTIONAL_CONSENT_TEXT'
      AND optional_consent_purpose IS NOT NULL
    )
    OR (
      policy_kind <> 'OPTIONAL_CONSENT_TEXT'
      AND optional_consent_purpose IS NULL
    )
  ),
  CONSTRAINT privacy_policy_versions_not_self_superseding CHECK (
    supersedes_policy_version_id IS NULL
    OR supersedes_policy_version_id <> policy_version_id
  ),
  UNIQUE (policy_kind, version_label)
);

CREATE TABLE privacy_consent_purposes (
  purpose privacy_optional_consent_purpose PRIMARY KEY,
  purpose_code text NOT NULL UNIQUE,
  is_genuinely_optional boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT privacy_consent_purposes_optional_only CHECK (
    is_genuinely_optional = true
  ),
  CONSTRAINT privacy_consent_purposes_code_safe CHECK (
    purpose_code ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'
  )
);

INSERT INTO privacy_consent_purposes (purpose, purpose_code) VALUES
  ('PORTFOLIO_PROPERTY_PHOTO_PUBLICATION', 'portfolio.property_photo.publication'),
  ('NON_ESSENTIAL_ANALYTICS', 'analytics.non_essential'),
  ('MARKETING_EMAIL', 'marketing.email');

CREATE TABLE privacy_consent_events (
  event_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  purpose privacy_optional_consent_purpose NOT NULL
    REFERENCES privacy_consent_purposes(purpose) ON DELETE RESTRICT,
  action privacy_consent_action NOT NULL,
  policy_version_id uuid NOT NULL
    REFERENCES privacy_policy_versions(policy_version_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT privacy_consent_events_revision_positive CHECK (revision > 0),
  UNIQUE (subject_user_id, purpose, revision)
);

CREATE INDEX privacy_consent_events_current_idx
  ON privacy_consent_events (subject_user_id, purpose, revision DESC);

CREATE TABLE privacy_retention_policy_versions (
  policy_version_id uuid PRIMARY KEY,
  category privacy_retention_category NOT NULL,
  version integer NOT NULL,
  duration_days integer,
  legal_review_state privacy_review_state NOT NULL DEFAULT 'UNRESOLVED',
  launch_state privacy_retention_launch_state NOT NULL DEFAULT 'BLOCKED',
  rationale_code text NOT NULL,
  supersedes_policy_version_id uuid
    REFERENCES privacy_retention_policy_versions(policy_version_id)
    ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT privacy_retention_policy_version_positive CHECK (version > 0),
  CONSTRAINT privacy_retention_policy_duration_bounded CHECK (
    duration_days IS NULL OR duration_days BETWEEN 1 AND 36500
  ),
  CONSTRAINT privacy_retention_policy_rationale_safe CHECK (
    rationale_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  CONSTRAINT privacy_retention_policy_review_consistent CHECK (
    (
      legal_review_state = 'UNRESOLVED'
      AND launch_state = 'BLOCKED'
      AND duration_days IS NULL
    )
    OR (
      legal_review_state = 'APPROVED'
      AND duration_days IS NOT NULL
    )
  ),
  CONSTRAINT privacy_retention_policy_not_self_superseding CHECK (
    supersedes_policy_version_id IS NULL
    OR supersedes_policy_version_id <> policy_version_id
  ),
  UNIQUE (category, version)
);

INSERT INTO privacy_retention_policy_versions (
  policy_version_id,
  category,
  version,
  duration_days,
  legal_review_state,
  launch_state,
  rationale_code
) VALUES
  ('12000000-0000-4000-8000-000000000001', 'ACCOUNT_CORE', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000002', 'ABANDONED_DRAFT', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000003', 'PRE_JOB_CONVERSATION', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000004', 'COMMERCIAL_JOB_RECORD', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000005', 'PRIVATE_JOB_MEDIA', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000006', 'PUBLIC_PORTFOLIO_MEDIA', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000007', 'CREDENTIAL_EVIDENCE', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000008', 'REJECTED_CREDENTIAL', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000009', 'MALWARE_QUARANTINE', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000010', 'DISPUTE_EVIDENCE', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000011', 'MODERATION_SECURITY', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000012', 'RISK_FLAG', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000013', 'APPLICATION_LOG', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000014', 'NOTIFICATION_DELIVERY', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000015', 'AUDIT_EVENT', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000016', 'PRIVACY_REQUEST_CASE', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED'),
  ('12000000-0000-4000-8000-000000000017', 'BACKUP', 1, NULL, 'UNRESOLVED', 'BLOCKED', 'LEGAL_REVIEW_REQUIRED');

CREATE INDEX privacy_retention_policy_current_idx
  ON privacy_retention_policy_versions (category, version DESC);

CREATE FUNCTION validate_privacy_retention_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_id uuid;
  current_id uuid;
  current_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('privacy-retention:' || NEW.category::text, 0)
  );

  SELECT policy_version_id
  INTO existing_id
  FROM privacy_retention_policy_versions
  WHERE policy_version_id = NEW.policy_version_id;

  -- Let the PK/idempotency path compare an existing event after this guard.
  IF existing_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT policy_version_id, version
  INTO current_id, current_version
  FROM privacy_retention_policy_versions
  WHERE category = NEW.category
  ORDER BY version DESC
  LIMIT 1
  FOR UPDATE;

  IF current_id IS NULL THEN
    IF NEW.version <> 1 OR NEW.supersedes_policy_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'first retention policy must be version 1 without predecessor';
    END IF;
  ELSIF NEW.version <> current_version + 1
    OR NEW.supersedes_policy_version_id IS DISTINCT FROM current_id THEN
    RAISE EXCEPTION 'retention policy must extend current category head contiguously';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_retention_policy_sequence_guard
BEFORE INSERT ON privacy_retention_policy_versions
FOR EACH ROW EXECUTE FUNCTION validate_privacy_retention_sequence();

CREATE TABLE privacy_request_cases (
  case_id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_type privacy_request_type NOT NULL,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX privacy_request_cases_subject_idx
  ON privacy_request_cases (subject_user_id, received_at DESC, case_id);

CREATE TABLE privacy_request_events (
  event_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  case_id uuid NOT NULL
    REFERENCES privacy_request_cases(case_id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  state privacy_request_state NOT NULL,
  deadline_at timestamptz,
  action_code text,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT privacy_request_events_revision_positive CHECK (revision > 0),
  CONSTRAINT privacy_request_events_action_safe CHECK (
    action_code IS NULL OR action_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  UNIQUE (case_id, revision)
);

CREATE INDEX privacy_request_events_current_idx
  ON privacy_request_events (case_id, revision DESC);

CREATE OR REPLACE FUNCTION set_privacy_history_server_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'privacy_request_cases' THEN
    NEW.received_at := CURRENT_TIMESTAMP;
  ELSIF TG_TABLE_NAME IN (
    'privacy_policy_versions',
    'privacy_consent_purposes',
    'privacy_retention_policy_versions'
  ) THEN
    NEW.created_at := CURRENT_TIMESTAMP;
  ELSE
    NEW.occurred_at := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_policy_versions_server_timestamp
BEFORE INSERT ON privacy_policy_versions
FOR EACH ROW EXECUTE FUNCTION set_privacy_history_server_timestamp();

CREATE TRIGGER privacy_consent_purposes_server_timestamp
BEFORE INSERT ON privacy_consent_purposes
FOR EACH ROW EXECUTE FUNCTION set_privacy_history_server_timestamp();

CREATE TRIGGER privacy_consent_events_server_timestamp
BEFORE INSERT ON privacy_consent_events
FOR EACH ROW EXECUTE FUNCTION set_privacy_history_server_timestamp();

CREATE TRIGGER privacy_retention_policy_server_timestamp
BEFORE INSERT ON privacy_retention_policy_versions
FOR EACH ROW EXECUTE FUNCTION set_privacy_history_server_timestamp();

CREATE TRIGGER privacy_request_cases_server_timestamp
BEFORE INSERT ON privacy_request_cases
FOR EACH ROW EXECUTE FUNCTION set_privacy_history_server_timestamp();

CREATE TRIGGER privacy_request_events_server_timestamp
BEFORE INSERT ON privacy_request_events
FOR EACH ROW EXECUTE FUNCTION set_privacy_history_server_timestamp();

CREATE OR REPLACE FUNCTION validate_optional_consent_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  accepted_policy privacy_policy_versions%ROWTYPE;
BEGIN
  SELECT * INTO accepted_policy
  FROM privacy_policy_versions
  WHERE policy_version_id = NEW.policy_version_id;

  IF NOT FOUND
    OR accepted_policy.policy_kind <> 'OPTIONAL_CONSENT_TEXT'
    OR accepted_policy.optional_consent_purpose <> NEW.purpose
    OR accepted_policy.review_state <> 'APPROVED'
    OR accepted_policy.effective_at > CURRENT_TIMESTAMP
  THEN
    RAISE EXCEPTION 'optional consent policy is not approved and effective';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_consent_events_policy_guard
BEFORE INSERT ON privacy_consent_events
FOR EACH ROW EXECUTE FUNCTION validate_optional_consent_policy();

CREATE OR REPLACE FUNCTION validate_privacy_consent_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_action privacy_consent_action;
  current_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.subject_user_id::text),
    hashtext(NEW.purpose::text)
  );
  SELECT action, revision
  INTO current_action, current_revision
  FROM privacy_consent_events
  WHERE subject_user_id = NEW.subject_user_id
    AND purpose = NEW.purpose
  ORDER BY revision DESC
  LIMIT 1;

  IF current_revision IS NULL THEN
    IF NEW.revision <> 1 OR NEW.action <> 'GRANTED' THEN
      RAISE EXCEPTION 'first consent event must be revision 1 GRANTED';
    END IF;
  ELSIF NEW.revision <> current_revision + 1 THEN
    RAISE EXCEPTION 'consent revisions must be contiguous';
  ELSIF NEW.action = current_action THEN
    RAISE EXCEPTION 'consent state must change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_consent_events_sequence_guard
BEFORE INSERT ON privacy_consent_events
FOR EACH ROW EXECUTE FUNCTION validate_privacy_consent_sequence();

CREATE OR REPLACE FUNCTION validate_privacy_request_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision integer;
  current_state privacy_request_state;
BEGIN
  PERFORM 1
  FROM privacy_request_cases
  WHERE case_id = NEW.case_id
  FOR UPDATE;

  SELECT state, revision
  INTO current_state, current_revision
  FROM privacy_request_events
  WHERE case_id = NEW.case_id
  ORDER BY revision DESC
  LIMIT 1;

  IF current_revision IS NULL THEN
    IF NEW.revision <> 1 OR NEW.state <> 'RECEIVED' THEN
      RAISE EXCEPTION 'first privacy request event must be revision 1 RECEIVED';
    END IF;
  ELSIF NEW.revision <> current_revision + 1 THEN
    RAISE EXCEPTION 'privacy request revisions must be contiguous';
  ELSIF NOT (
    (current_state = 'RECEIVED' AND NEW.state IN ('IDENTITY_VERIFICATION_PENDING', 'VERIFIED'))
    OR (current_state = 'IDENTITY_VERIFICATION_PENDING' AND NEW.state IN ('VERIFIED', 'REJECTED'))
    OR (current_state = 'VERIFIED' AND NEW.state = 'IN_REVIEW')
    OR (current_state = 'IN_REVIEW' AND NEW.state IN ('ACTION_REQUIRED', 'COMPLETED', 'REJECTED'))
    OR (current_state = 'ACTION_REQUIRED' AND NEW.state IN ('IN_REVIEW', 'COMPLETED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid privacy request transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_request_events_sequence_guard
BEFORE INSERT ON privacy_request_events
FOR EACH ROW EXECUTE FUNCTION validate_privacy_request_sequence();

CREATE OR REPLACE FUNCTION prevent_privacy_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'privacy history is append-only';
END;
$$;

CREATE TRIGGER privacy_policy_versions_append_only
BEFORE UPDATE OR DELETE ON privacy_policy_versions
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_history_mutation();

CREATE TRIGGER privacy_consent_purposes_append_only
BEFORE UPDATE OR DELETE ON privacy_consent_purposes
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_history_mutation();

CREATE TRIGGER privacy_consent_events_append_only
BEFORE UPDATE OR DELETE ON privacy_consent_events
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_history_mutation();

CREATE TRIGGER privacy_retention_policy_append_only
BEFORE UPDATE OR DELETE ON privacy_retention_policy_versions
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_history_mutation();

CREATE TRIGGER privacy_request_cases_append_only
BEFORE UPDATE OR DELETE ON privacy_request_cases
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_history_mutation();

CREATE TRIGGER privacy_request_events_append_only
BEFORE UPDATE OR DELETE ON privacy_request_events
FOR EACH ROW EXECUTE FUNCTION prevent_privacy_history_mutation();

COMMENT ON TABLE privacy_consent_events IS
  'Append-only optional-consent history. Contract, legal-obligation and legitimate-interest processing must never be inserted here.';
COMMENT ON TABLE privacy_retention_policy_versions IS
  'Seeded BLOCKED/UNRESOLVED. Cleanup execution must fail closed until a later legally reviewed READY version exists.';
COMMENT ON TABLE privacy_request_events IS
  'Minimized case state/actions only. Raw identity evidence, exports, request bodies and third-party personal data are not stored in this ledger.';
COMMENT ON TABLE privacy_request_cases IS
  'Account closure is represented without deleting the User row; category-specific delete/anonymize/retain work remains a reviewed future workflow.';
