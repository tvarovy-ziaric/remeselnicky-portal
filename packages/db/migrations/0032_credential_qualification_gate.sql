CREATE TYPE credential_qualification_requirement AS ENUM (
  'REQUIRED',
  'OPTIONAL'
);

CREATE TYPE credential_qualification_eligibility AS ENUM (
  'QUALIFIED',
  'NOT_QUALIFIED'
);

CREATE TYPE credential_qualification_reason AS ENUM (
  'REQUIRED_CREDENTIAL_APPROVED',
  'REQUIRED_CREDENTIAL_MISSING',
  'OPTIONAL_CREDENTIAL_APPROVED',
  'OPTIONAL_CREDENTIAL_NOT_APPROVED'
);

-- Legal qualification content is installed only as an expert-reviewed full
-- release. This migration deliberately contains no Slovak policy seed.
CREATE TABLE credential_qualification_policy_releases (
  release_id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  taxonomy_release_id uuid NOT NULL
    REFERENCES profession_taxonomy_releases(release_id) ON DELETE RESTRICT,
  content_class taxonomy_content_class NOT NULL,
  review_state taxonomy_review_state NOT NULL,
  review_reference text,
  supersedes_release_id uuid UNIQUE
    REFERENCES credential_qualification_policy_releases(release_id)
    ON DELETE RESTRICT,
  checksum_sha256 char(64) NOT NULL UNIQUE,
  installation_txid bigint NOT NULL DEFAULT txid_current(),
  installed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (release_id, taxonomy_release_id),
  CONSTRAINT credential_qualification_release_checksum_safe CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT credential_qualification_release_review_context CHECK (
    (review_state = 'HUMAN_REVIEW_APPROVED' AND review_reference IS NOT NULL
      AND review_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$')
    OR (review_state <> 'HUMAN_REVIEW_APPROVED' AND review_reference IS NULL)
  ),
  CONSTRAINT credential_qualification_release_supersession CHECK (
    (version = 1 AND supersedes_release_id IS NULL)
    OR (version > 1 AND supersedes_release_id IS NOT NULL
      AND supersedes_release_id <> release_id)
  )
);

CREATE TABLE credential_qualification_policy_entries (
  release_id uuid NOT NULL,
  taxonomy_release_id uuid NOT NULL,
  profession_code text NOT NULL,
  credential_type_code text NOT NULL
    REFERENCES credential_type_policies(code) ON DELETE RESTRICT,
  requirement credential_qualification_requirement NOT NULL,
  PRIMARY KEY (release_id, profession_code, credential_type_code),
  FOREIGN KEY (release_id, taxonomy_release_id)
    REFERENCES credential_qualification_policy_releases(
      release_id, taxonomy_release_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (taxonomy_release_id, profession_code)
    REFERENCES taxonomy_professions(release_id, profession_code)
    ON DELETE RESTRICT
);

CREATE TABLE credential_qualification_policy_activation_events (
  activation_id uuid PRIMARY KEY,
  activation_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  release_id uuid NOT NULL UNIQUE
    REFERENCES credential_qualification_policy_releases(release_id)
    ON DELETE RESTRICT,
  previous_release_id uuid
    REFERENCES credential_qualification_policy_releases(release_id)
    ON DELETE RESTRICT,
  actor_reference text NOT NULL,
  review_reference text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT credential_qualification_activation_actor_safe CHECK (
    actor_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
  ),
  CONSTRAINT credential_qualification_activation_review_safe CHECK (
    review_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
  )
);

CREATE FUNCTION guard_credential_qualification_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'credential qualification policy releases are append-only';
  END IF;
  NEW.installation_txid := txid_current();
  NEW.installed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_qualification_release_guard
BEFORE INSERT OR UPDATE OR DELETE ON credential_qualification_policy_releases
FOR EACH ROW EXECUTE FUNCTION guard_credential_qualification_release();

CREATE FUNCTION guard_credential_qualification_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_installation_txid bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'credential qualification policy entries are append-only';
  END IF;
  SELECT policy.installation_txid INTO policy_installation_txid
  FROM credential_qualification_policy_releases policy
  WHERE policy.release_id = NEW.release_id
  FOR KEY SHARE;
  IF policy_installation_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'credential qualification entries must be installed atomically with their release';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM credential_qualification_policy_activation_events activation
    WHERE activation.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'activated credential qualification policy is sealed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_qualification_entry_guard
BEFORE INSERT OR UPDATE OR DELETE ON credential_qualification_policy_entries
FOR EACH ROW EXECUTE FUNCTION guard_credential_qualification_entry();

CREATE FUNCTION guard_credential_qualification_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_release credential_qualification_policy_releases%ROWTYPE;
  existing_activation credential_qualification_policy_activation_events%ROWTYPE;
  active_taxonomy_release_id uuid;
  latest_release_id uuid;
  latest_version integer;
  expected_version integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'credential qualification activations are append-only';
  END IF;

  -- The transaction-scoped lock serializes activation attempts without a
  -- lock-upgrade deadlock between concurrent INSERT statements.
  PERFORM pg_advisory_xact_lock(20060032);
  SELECT * INTO existing_activation
  FROM credential_qualification_policy_activation_events activation
  WHERE activation.activation_id = NEW.activation_id;
  IF FOUND THEN
    IF existing_activation.release_id IS DISTINCT FROM NEW.release_id
      OR existing_activation.previous_release_id IS DISTINCT FROM NEW.previous_release_id
      OR existing_activation.actor_reference IS DISTINCT FROM NEW.actor_reference
      OR existing_activation.review_reference IS DISTINCT FROM NEW.review_reference
    THEN
      RAISE EXCEPTION 'credential qualification activation provenance conflicts';
    END IF;
    RETURN NEW;
  END IF;
  -- A SHARE table lock conflicts with the ROW EXCLUSIVE lock taken by an
  -- activation insert, pinning the taxonomy snapshot until this transaction
  -- commits.
  LOCK TABLE profession_taxonomy_activation_events IN SHARE MODE;

  SELECT * INTO policy_release
  FROM credential_qualification_policy_releases policy
  WHERE policy.release_id = NEW.release_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential qualification policy release is unavailable';
  END IF;

  IF policy_release.content_class <> 'CANONICAL'
    OR policy_release.review_state <> 'HUMAN_REVIEW_APPROVED'
    OR policy_release.review_reference IS NULL
  THEN
    RAISE EXCEPTION 'credential qualification policy requires expert-reviewed canonical content';
  END IF;

  SELECT taxonomy.release_id INTO active_taxonomy_release_id
  FROM profession_taxonomy_activation_events taxonomy
  ORDER BY taxonomy.activation_sequence DESC
  LIMIT 1
  FOR SHARE;
  IF active_taxonomy_release_id IS DISTINCT FROM policy_release.taxonomy_release_id THEN
    RAISE EXCEPTION 'credential qualification policy must target the current profession taxonomy';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM credential_qualification_policy_entries entry
    WHERE entry.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'credential qualification policy release cannot be empty';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM credential_qualification_policy_entries entry
    LEFT JOIN taxonomy_professions profession
      ON profession.release_id = entry.taxonomy_release_id
      AND profession.profession_code = entry.profession_code
    LEFT JOIN credential_type_policies credential
      ON credential.code = entry.credential_type_code
    WHERE entry.release_id = NEW.release_id
      AND (
        entry.taxonomy_release_id IS DISTINCT FROM policy_release.taxonomy_release_id
        OR profession.state IS DISTINCT FROM 'ACTIVE'
        OR credential.active IS DISTINCT FROM true
      )
  ) THEN
    RAISE EXCEPTION 'credential qualification policy contains inactive or incoherent entries';
  END IF;

  SELECT policy.release_id, policy.version
  INTO latest_release_id, latest_version
  FROM credential_qualification_policy_activation_events activation
  JOIN credential_qualification_policy_releases policy
    ON policy.release_id = activation.release_id
  ORDER BY activation.activation_sequence DESC
  LIMIT 1;
  expected_version := COALESCE(latest_version, 0) + 1;
  IF policy_release.version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'credential qualification policy versions must be contiguous';
  END IF;
  IF NEW.previous_release_id IS DISTINCT FROM latest_release_id
    OR policy_release.supersedes_release_id IS DISTINCT FROM latest_release_id
  THEN
    RAISE EXCEPTION 'credential qualification policy supersession is stale';
  END IF;

  NEW.activated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_qualification_activation_guard
BEFORE INSERT OR UPDATE OR DELETE
ON credential_qualification_policy_activation_events
FOR EACH ROW EXECUTE FUNCTION guard_credential_qualification_activation();

CREATE VIEW current_credential_qualification_policies
WITH (security_invoker = true)
AS
WITH current_activation AS (
  SELECT activation.release_id
  FROM credential_qualification_policy_activation_events activation
  ORDER BY activation.activation_sequence DESC
  LIMIT 1
), current_taxonomy AS (
  SELECT activation.release_id
  FROM profession_taxonomy_activation_events activation
  ORDER BY activation.activation_sequence DESC
  LIMIT 1
)
SELECT
  entry.profession_code,
  entry.credential_type_code,
  entry.requirement
FROM current_activation activation
JOIN credential_qualification_policy_releases policy
  ON policy.release_id = activation.release_id
JOIN current_taxonomy taxonomy
  ON taxonomy.release_id = policy.taxonomy_release_id
JOIN credential_qualification_policy_entries entry
  ON entry.release_id = policy.release_id
  AND entry.taxonomy_release_id = policy.taxonomy_release_id
JOIN taxonomy_professions profession
  ON profession.release_id = entry.taxonomy_release_id
  AND profession.profession_code = entry.profession_code
  AND profession.state = 'ACTIVE'
JOIN credential_type_policies credential
  ON credential.code = entry.credential_type_code
  AND credential.active;

CREATE FUNCTION evaluate_craftsman_credential_qualification(
  requested_profile_id uuid,
  requested_profession_code text,
  requested_credential_type_code text
)
RETURNS TABLE (
  eligibility credential_qualification_eligibility,
  requirement credential_qualification_requirement,
  current_approved boolean,
  reason_code credential_qualification_reason
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH applicable AS (
    SELECT policy.requirement
    FROM public.current_credential_qualification_policies policy
    WHERE policy.profession_code = requested_profession_code
      AND policy.credential_type_code = requested_credential_type_code
  ), eligible_profile AS (
    SELECT searchable.craftsman_profile_id
    FROM public.current_searchable_craftsman_profiles searchable
    WHERE searchable.craftsman_profile_id = requested_profile_id
  ), evaluated AS (
    SELECT
      applicable.requirement,
      EXISTS (
        SELECT 1
        FROM public.current_searchable_craftsman_credentials credential
        WHERE credential.craftsman_profile_id = eligible_profile.craftsman_profile_id
          AND credential.profession_code = requested_profession_code
          AND credential.credential_type_code = requested_credential_type_code
      ) AS current_approved
    FROM applicable
    CROSS JOIN eligible_profile
  )
  SELECT
    CASE
      WHEN evaluated.requirement = 'REQUIRED' AND NOT evaluated.current_approved
        THEN 'NOT_QUALIFIED'::public.credential_qualification_eligibility
      ELSE 'QUALIFIED'::public.credential_qualification_eligibility
    END,
    evaluated.requirement,
    evaluated.current_approved,
    CASE
      WHEN evaluated.requirement = 'REQUIRED' AND evaluated.current_approved
        THEN 'REQUIRED_CREDENTIAL_APPROVED'::public.credential_qualification_reason
      WHEN evaluated.requirement = 'REQUIRED'
        THEN 'REQUIRED_CREDENTIAL_MISSING'::public.credential_qualification_reason
      WHEN evaluated.current_approved
        THEN 'OPTIONAL_CREDENTIAL_APPROVED'::public.credential_qualification_reason
      ELSE 'OPTIONAL_CREDENTIAL_NOT_APPROVED'::public.credential_qualification_reason
    END
  FROM evaluated;
$$;

COMMENT ON VIEW current_credential_qualification_policies IS
  'Current expert-reviewed full-release REQUIRED/OPTIONAL profession credential rules. Empty until an external legal-policy review is activated.';
COMMENT ON FUNCTION evaluate_craftsman_credential_qualification(uuid, text, text) IS
  'Fail-closed exact qualification gate. SECURITY INVOKER does not bypass privileges and returns no claim, evidence, reviewer, reason, media or storage provenance.';
