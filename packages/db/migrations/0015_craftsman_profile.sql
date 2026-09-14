CREATE TYPE craftsman_profile_type AS ENUM ('INDIVIDUAL', 'COMPANY');

CREATE TABLE craftsman_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE
    REFERENCES users(id) ON DELETE RESTRICT,
  profile_type craftsman_profile_type NOT NULL,
  real_first_name text,
  real_last_name text,
  nickname text,
  official_company_name text,
  company_registration_number char(8),
  about text,
  identity_verified_at timestamptz,
  identity_verification_reference text,
  company_registration_verified_at timestamptz,
  company_registration_verification_reference text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT craftsman_profiles_revision_positive CHECK (revision > 0),
  CONSTRAINT craftsman_profiles_timestamps_ordered CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT craftsman_profiles_individual_identity_paired CHECK (
    (real_first_name IS NULL) = (real_last_name IS NULL)
  ),
  CONSTRAINT craftsman_profiles_fields_match_type CHECK (
    (
      profile_type = 'INDIVIDUAL'
      AND official_company_name IS NULL
      AND company_registration_number IS NULL
      AND company_registration_verified_at IS NULL
      AND company_registration_verification_reference IS NULL
    )
    OR (
      profile_type = 'COMPANY'
      AND real_first_name IS NULL
      AND real_last_name IS NULL
      AND nickname IS NULL
    )
  ),
  CONSTRAINT craftsman_profiles_real_first_name_safe CHECK (
    real_first_name IS NULL OR (
      real_first_name = btrim(real_first_name)
      AND length(real_first_name) BETWEEN 1 AND 120
      AND real_first_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT craftsman_profiles_real_last_name_safe CHECK (
    real_last_name IS NULL OR (
      real_last_name = btrim(real_last_name)
      AND length(real_last_name) BETWEEN 1 AND 120
      AND real_last_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT craftsman_profiles_nickname_safe CHECK (
    nickname IS NULL OR (
      nickname = btrim(nickname)
      AND length(nickname) BETWEEN 1 AND 80
      AND nickname !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT craftsman_profiles_company_name_safe CHECK (
    official_company_name IS NULL OR (
      official_company_name = btrim(official_company_name)
      AND length(official_company_name) BETWEEN 1 AND 200
      AND official_company_name !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT craftsman_profiles_registration_number_safe CHECK (
    company_registration_number IS NULL
    OR company_registration_number ~ '^[0-9]{8}$'
  ),
  CONSTRAINT craftsman_profiles_about_safe CHECK (
    about IS NULL OR (
      about = btrim(about)
      AND length(about) BETWEEN 1 AND 2000
      AND about !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
    )
  ),
  CONSTRAINT craftsman_profiles_identity_verification_paired CHECK (
    (identity_verified_at IS NULL)
      = (identity_verification_reference IS NULL)
  ),
  CONSTRAINT craftsman_profiles_identity_verification_has_identity CHECK (
    identity_verified_at IS NULL OR (
      (profile_type = 'INDIVIDUAL'
        AND real_first_name IS NOT NULL
        AND real_last_name IS NOT NULL)
      OR (profile_type = 'COMPANY' AND official_company_name IS NOT NULL)
    )
  ),
  CONSTRAINT craftsman_profiles_identity_verification_reference_safe CHECK (
    identity_verification_reference IS NULL OR (
      identity_verification_reference = btrim(identity_verification_reference)
      AND identity_verification_reference
        ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
    )
  ),
  CONSTRAINT craftsman_profiles_registration_verification_paired CHECK (
    (company_registration_verified_at IS NULL)
      = (company_registration_verification_reference IS NULL)
  ),
  CONSTRAINT craftsman_profiles_registration_verification_has_number CHECK (
    company_registration_verified_at IS NULL OR (
      profile_type = 'COMPANY' AND company_registration_number IS NOT NULL
    )
  ),
  CONSTRAINT craftsman_profiles_registration_verification_reference_safe CHECK (
    company_registration_verification_reference IS NULL OR (
      company_registration_verification_reference
        = btrim(company_registration_verification_reference)
      AND company_registration_verification_reference
        ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$'
    )
  )
);

CREATE FUNCTION initialize_craftsman_profile_draft()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_state user_account_state;
BEGIN
  SELECT account_state INTO owner_state
  FROM users
  WHERE id = NEW.owner_user_id
  FOR UPDATE;

  IF owner_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'craftsman profile owner must be ACTIVE';
  END IF;

  NEW.revision := 1;
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  NEW.identity_verified_at := NULL;
  NEW.identity_verification_reference := NULL;
  NEW.company_registration_verified_at := NULL;
  NEW.company_registration_verification_reference := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profiles_active_owner_insert_guard
BEFORE INSERT ON craftsman_profiles
FOR EACH ROW EXECUTE FUNCTION initialize_craftsman_profile_draft();

CREATE FUNCTION guard_craftsman_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_state user_account_state;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'craftsman profile history cannot be hard-deleted';
  END IF;

  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'craftsman profile ownership cannot be reassigned in place';
  END IF;

  SELECT account_state INTO owner_state
  FROM users
  WHERE id = OLD.owner_user_id
  FOR UPDATE;

  IF owner_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'craftsman profile owner must be ACTIVE';
  END IF;

  IF ROW(
    NEW.profile_type,
    NEW.real_first_name,
    NEW.real_last_name,
    NEW.official_company_name
  ) IS DISTINCT FROM ROW(
    OLD.profile_type,
    OLD.real_first_name,
    OLD.real_last_name,
    OLD.official_company_name
  ) AND (
    NEW.identity_verified_at IS NOT NULL
    OR NEW.identity_verification_reference IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'changed identity must clear prior verification provenance';
  END IF;

  IF ROW(NEW.profile_type, NEW.company_registration_number)
    IS DISTINCT FROM ROW(OLD.profile_type, OLD.company_registration_number)
    AND (
      NEW.company_registration_verified_at IS NOT NULL
      OR NEW.company_registration_verification_reference IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'changed registration must clear prior verification provenance';
  END IF;

  NEW.revision := OLD.revision + 1;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profiles_mutation_guard
BEFORE UPDATE OR DELETE ON craftsman_profiles
FOR EACH ROW EXECUTE FUNCTION guard_craftsman_profile_mutation();
