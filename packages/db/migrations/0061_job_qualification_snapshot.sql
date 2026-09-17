-- Accepted credentials and the active policy decision are historical facts.
-- Later revocation, expiry or policy activation cannot rewrite this record.
CREATE TABLE job_qualification_snapshots (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  profession_code text NOT NULL,
  policy_release_id uuid REFERENCES credential_qualification_policy_releases(
    release_id
  ) ON DELETE RESTRICT,
  requirements jsonb NOT NULL,
  approved_claims jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  CONSTRAINT job_qualification_requirements_array CHECK (
    jsonb_typeof(requirements) = 'array'
  ),
  CONSTRAINT job_qualification_claims_array CHECK (
    jsonb_typeof(approved_claims) = 'array'
  )
);

CREATE FUNCTION capture_job_qualification_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  accepted_profession_code text;
  accepted_policy_release_id uuid;
  required_missing boolean;
  requirements jsonb;
  approved_claims jsonb;
BEGIN
  SELECT snapshot.request_snapshot #>>
    '{sections,request.core,payload,primaryProfessionCode}'
    INTO accepted_profession_code
  FROM job_agreement_snapshots snapshot WHERE snapshot.job_id = NEW.id;
  IF accepted_profession_code IS NULL OR accepted_profession_code = '' THEN
    RAISE EXCEPTION 'accepted Job profession snapshot required';
  END IF;

  SELECT activation.release_id INTO accepted_policy_release_id
  FROM credential_qualification_policy_activation_events activation
  ORDER BY activation.activation_sequence DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'credentialTypeCode', policy.credential_type_code,
    'requirement', policy.requirement,
    'qualifyingClaimId', qualifying.id,
    'qualifyingClaimRevision', qualifying.revision,
    'qualifyingClaimExpiresOn', qualifying.expires_on
  ) ORDER BY policy.credential_type_code), '[]'::jsonb),
    COALESCE(bool_or(policy.requirement = 'REQUIRED'
      AND qualifying.id IS NULL), false)
    INTO requirements, required_missing
  FROM current_credential_qualification_policies policy
  LEFT JOIN LATERAL (
    SELECT claim.id, claim.revision, claim.expires_on
    FROM credential_claims claim
    JOIN current_craftsman_professions provider_profession
      ON provider_profession.id = claim.craftsman_profession_id
      AND provider_profession.craftsman_profile_id = claim.craftsman_profile_id
    WHERE claim.craftsman_profile_id = NEW.primary_craftsman_profile_id
      AND provider_profession.profession_code = accepted_profession_code
      AND claim.credential_type_code = policy.credential_type_code
      AND claim.state = 'APPROVED'
      AND (claim.expires_on IS NULL
        OR claim.expires_on >= clock_timestamp()::date)
    ORDER BY claim.reviewed_at DESC NULLS LAST, claim.id
    LIMIT 1
  ) qualifying ON true
  WHERE policy.profession_code = accepted_profession_code;
  IF required_missing THEN
    RAISE EXCEPTION 'currently approved required credential missing';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'claimId', claim.id,
    'claimRevision', claim.revision,
    'credentialTypeCode', claim.credential_type_code,
    'state', claim.state,
    'expiresOn', claim.expires_on,
    'reviewedAt', claim.reviewed_at
  ) ORDER BY claim.credential_type_code, claim.id), '[]'::jsonb)
    INTO approved_claims
  FROM credential_claims claim
  JOIN current_craftsman_professions provider_profession
    ON provider_profession.id = claim.craftsman_profession_id
    AND provider_profession.craftsman_profile_id = claim.craftsman_profile_id
  WHERE claim.craftsman_profile_id = NEW.primary_craftsman_profile_id
    AND provider_profession.profession_code = accepted_profession_code
    AND claim.state = 'APPROVED'
    AND (claim.expires_on IS NULL
      OR claim.expires_on >= clock_timestamp()::date);

  INSERT INTO job_qualification_snapshots (
    job_id, profession_code, policy_release_id, requirements,
    approved_claims, captured_at
  ) VALUES (
    NEW.id, accepted_profession_code, accepted_policy_release_id, requirements,
    approved_claims, NEW.accepted_at
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER jobs_capture_qualification_snapshot
AFTER INSERT ON jobs
FOR EACH ROW EXECUTE FUNCTION capture_job_qualification_snapshot();

CREATE FUNCTION reject_job_qualification_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accepted Job qualification snapshot is immutable';
END;
$$;

CREATE TRIGGER job_qualification_snapshots_immutable
BEFORE UPDATE OR DELETE ON job_qualification_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_job_qualification_snapshot_mutation();

COMMENT ON TABLE job_qualification_snapshots IS
  'Exact provider credential/policy state captured with Job acceptance. This does not expose credential evidence documents to ordinary Job participants.';
