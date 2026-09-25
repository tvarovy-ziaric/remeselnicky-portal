CREATE TYPE job_property_photo_consent_action AS ENUM (
  'GRANTED', 'DECLINED', 'WITHDRAWN'
);

CREATE TABLE job_property_photo_consent_events (
  event_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action job_property_photo_consent_action NOT NULL,
  policy_version_id uuid NOT NULL
    REFERENCES privacy_policy_versions(policy_version_id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, media_asset_id, revision)
);

CREATE INDEX job_property_photo_consent_customer_idx
  ON job_property_photo_consent_events (
    customer_user_id, job_id, occurred_at DESC
  );

CREATE VIEW current_job_property_photo_consents
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (event.job_id, event.media_asset_id)
  event.event_id, event.correlation_id, event.job_id,
  event.media_asset_id, event.customer_user_id, event.actor_user_id,
  event.action, event.policy_version_id, event.revision,
  event.occurred_at
FROM job_property_photo_consent_events event
ORDER BY event.job_id, event.media_asset_id, event.revision DESC;

CREATE FUNCTION job_property_photo_is_candidate(
  candidate_job_id uuid, candidate_media_asset_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM job_conversation_media job_media
    JOIN media_assets asset ON asset.id = job_media.media_asset_id
      AND asset.kind = 'IMAGE' AND asset.status = 'READY'
    JOIN media_asset_storage_objects canonical
      ON canonical.media_asset_id = asset.id
      AND canonical.role = 'CANONICAL'
      AND canonical.storage_area = 'private'
      AND canonical.revoked_at IS NULL
      AND canonical.content_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND canonical.content_sha256 IS NOT NULL
    WHERE job_media.job_id = candidate_job_id
      AND job_media.media_asset_id = candidate_media_asset_id
      AND job_media.media_kind = 'IMAGE'
  )
$$;

CREATE FUNCTION job_property_photo_consent_is_current(
  candidate_job_id uuid,
  candidate_media_asset_id uuid,
  candidate_customer_user_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM current_job_property_photo_consents consent
    JOIN privacy_policy_versions policy
      ON policy.policy_version_id = consent.policy_version_id
      AND policy.policy_kind = 'OPTIONAL_CONSENT_TEXT'
      AND policy.optional_consent_purpose =
        'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION'
      AND policy.review_state = 'APPROVED'
      AND policy.effective_at IS NOT NULL
    WHERE consent.job_id = candidate_job_id
      AND consent.media_asset_id = candidate_media_asset_id
      AND consent.customer_user_id = candidate_customer_user_id
      AND consent.action = 'GRANTED'
  )
$$;

CREATE FUNCTION validate_job_property_photo_consent_event()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE expected_customer_id uuid;
DECLARE actor_state user_account_state;
DECLARE current_event job_property_photo_consent_events%ROWTYPE;
DECLARE policy privacy_policy_versions%ROWTYPE;
BEGIN
  NEW.occurred_at := clock_timestamp();
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'exact Job required for photo consent'; END IF;

  SELECT customer.owner_user_id INTO expected_customer_id
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  WHERE job.id = NEW.job_id;
  IF expected_customer_id IS NULL
    OR NEW.customer_user_id IS DISTINCT FROM expected_customer_id
    OR NEW.actor_user_id IS DISTINCT FROM expected_customer_id THEN
    RAISE EXCEPTION 'exact Job customer required for photo consent';
  END IF;

  SELECT account_state INTO actor_state
  FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  IF actor_state IS NULL
    OR (NEW.action IN ('GRANTED', 'DECLINED') AND actor_state <> 'ACTIVE')
    OR (NEW.action = 'WITHDRAWN'
      AND actor_state NOT IN ('ACTIVE', 'SUSPENDED')) THEN
    RAISE EXCEPTION 'eligible Job customer required for photo consent';
  END IF;
  IF NOT job_property_photo_is_candidate(NEW.job_id, NEW.media_asset_id) THEN
    RAISE EXCEPTION 'same-Job READY private property photo required';
  END IF;

  SELECT * INTO current_event
  FROM job_property_photo_consent_events
  WHERE job_id = NEW.job_id AND media_asset_id = NEW.media_asset_id
  ORDER BY revision DESC LIMIT 1 FOR UPDATE;
  IF current_event.revision IS NULL THEN
    IF NEW.revision <> 1 OR NEW.action = 'WITHDRAWN' THEN
      RAISE EXCEPTION 'first property-photo decision must grant or decline';
    END IF;
  ELSE
    IF NEW.revision <> current_event.revision + 1 THEN
      RAISE EXCEPTION 'property-photo consent revisions must be contiguous';
    END IF;
    IF NEW.action = current_event.action THEN
      RAISE EXCEPTION 'property-photo consent decision is unchanged';
    END IF;
    IF NEW.action = 'WITHDRAWN' AND current_event.action <> 'GRANTED' THEN
      RAISE EXCEPTION 'only a current property-photo grant can be withdrawn';
    END IF;
    IF NEW.action = 'DECLINED' AND current_event.action = 'GRANTED' THEN
      RAISE EXCEPTION 'a current property-photo grant must be withdrawn';
    END IF;
  END IF;

  SELECT * INTO policy
  FROM privacy_policy_versions
  WHERE policy_version_id = NEW.policy_version_id
    AND policy_kind = 'OPTIONAL_CONSENT_TEXT'
    AND optional_consent_purpose =
      'PORTFOLIO_PROPERTY_PHOTO_PUBLICATION'
    AND review_state = 'APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approved property-photo consent policy required';
  END IF;
  IF NEW.action = 'WITHDRAWN' THEN
    IF NEW.policy_version_id IS DISTINCT FROM current_event.policy_version_id THEN
      RAISE EXCEPTION 'withdrawal must reference the exact granted policy';
    END IF;
  ELSIF policy.effective_at IS NULL
    OR policy.effective_at > NEW.occurred_at THEN
    RAISE EXCEPTION 'effective property-photo consent policy required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_property_photo_consent_validate
BEFORE INSERT ON job_property_photo_consent_events
FOR EACH ROW EXECUTE FUNCTION validate_job_property_photo_consent_event();

CREATE FUNCTION prevent_job_property_photo_consent_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'property-photo consent history is append-only';
END;
$$;

CREATE TRIGGER job_property_photo_consent_immutable
BEFORE UPDATE OR DELETE ON job_property_photo_consent_events
FOR EACH ROW EXECUTE FUNCTION prevent_job_property_photo_consent_mutation();

COMMENT ON TABLE job_property_photo_consent_events IS
  'Versioned exact-Job/exact-photo customer grant, decline or withdrawal for optional public portfolio use. Completion and private Job evidence remain independent.';
COMMENT ON VIEW current_job_property_photo_consents IS
  'Current per-photo decision only; historical grants and withdrawals remain immutable.';
COMMENT ON FUNCTION job_property_photo_consent_is_current(uuid, uuid, uuid) IS
  'Fail-closed public-use predicate. A current exact-purpose grant is necessary but does not itself publish a private Job photo.';
