CREATE TABLE customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE
    REFERENCES users(id) ON DELETE RESTRICT,
  is_public boolean NOT NULL DEFAULT false,
  is_indexable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_profiles_never_public CHECK (NOT is_public),
  CONSTRAINT customer_profiles_never_indexable CHECK (NOT is_indexable),
  CONSTRAINT customer_profiles_update_not_before_creation CHECK (
    updated_at >= created_at
  )
);

CREATE FUNCTION enforce_customer_profile_active_owner()
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
  IF owner_state IS DISTINCT FROM 'ACTIVE'::user_account_state THEN
    RAISE EXCEPTION 'customer profile owner account must be active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_profiles_active_owner_guard
BEFORE INSERT ON customer_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_customer_profile_active_owner();

CREATE FUNCTION protect_customer_profile_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'customer profile identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_profiles_identity_guard
BEFORE UPDATE ON customer_profiles
FOR EACH ROW EXECUTE FUNCTION protect_customer_profile_identity();

CREATE FUNCTION prevent_customer_profile_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'customer profile history cannot be deleted by ordinary operation';
END;
$$;

CREATE TRIGGER customer_profiles_delete_guard
BEFORE DELETE ON customer_profiles
FOR EACH ROW EXECUTE FUNCTION prevent_customer_profile_delete();
