CREATE TYPE craftsman_profile_review_state AS ENUM (
  'DRAFT', 'PENDING', 'APPROVED', 'REJECTED'
);
CREATE TYPE craftsman_profile_owner_visibility AS ENUM ('PUBLIC', 'HIDDEN');
CREATE TYPE craftsman_profile_moderation_state AS ENUM (
  'ALLOWED', 'HIDDEN', 'RESTRICTED'
);
CREATE TYPE craftsman_profile_publication_actor_kind AS ENUM (
  'OWNER', 'ADMIN', 'SYSTEM'
);
CREATE TYPE craftsman_profile_publication_command_kind AS ENUM (
  'SUBMIT_REVIEW',
  'SET_OWNER_VISIBILITY',
  'ADMIN_APPROVE',
  'ADMIN_REJECT',
  'MODERATION_HIDE',
  'MODERATION_RESTRICT',
  'MODERATION_RESTORE',
  'IDENTITY_REVIEW_REQUIRED'
);

CREATE OR REPLACE FUNCTION craftsman_profile_missing_publication_requirements(
  target_profile_id uuid
)
RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT ARRAY_REMOVE(ARRAY[
    CASE WHEN NOT (
      (profile.profile_type = 'INDIVIDUAL'
        AND profile.real_first_name IS NOT NULL
        AND profile.real_last_name IS NOT NULL)
      OR (profile.profile_type = 'COMPANY'
        AND profile.official_company_name IS NOT NULL)
    ) THEN 'VALID_IDENTITY' END,
    CASE WHEN profile.about IS NULL THEN 'ABOUT' END,
    CASE WHEN NOT EXISTS (
      SELECT 1
      FROM current_craftsman_professions profession
      WHERE profession.craftsman_profile_id = profile.id
        AND profession.state = 'ACTIVE'
        AND profession.declared_level IS NOT NULL
    ) THEN 'ACTIVE_PROFESSION_WITH_DECLARED_LEVEL' END,
    CASE WHEN service_area.base_municipality_code IS NULL
      THEN 'BASE_MUNICIPALITY' END,
    CASE WHEN service_area.normal_radius_meters IS NULL
      THEN 'NORMAL_RADIUS' END
  ]::text[], NULL)
  FROM craftsman_profiles profile
  LEFT JOIN current_craftsman_service_areas service_area
    ON service_area.craftsman_profile_id = profile.id
  WHERE profile.id = target_profile_id
$$;

CREATE TABLE craftsman_profile_publication_commands (
  command_id uuid PRIMARY KEY,
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  actor_kind craftsman_profile_publication_actor_kind NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  actor_system_reference text,
  actor_capability text,
  authorization_session_hash char(64),
  mfa_factor_id uuid REFERENCES admin_mfa_factors(id) ON DELETE RESTRICT,
  mfa_authenticated_at timestamptz,
  correlation_id uuid,
  audit_event_id uuid
    REFERENCES audit_events(event_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  command_kind craftsman_profile_publication_command_kind NOT NULL,
  expected_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  review_state craftsman_profile_review_state NOT NULL,
  owner_visibility craftsman_profile_owner_visibility NOT NULL,
  moderation_state craftsman_profile_moderation_state NOT NULL,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  rejection_reason_code text,
  rejection_user_facing_reason text,
  rejected_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  moderation_reason_category text,
  moderation_reason_code text,
  moderation_policy_version text,
  moderated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  moderated_at timestamptz,
  identity_review_reason_code text,
  identity_review_rule_reference text,
  command_reason_category text,
  command_reason_code text,
  command_policy_version text,
  command_rejection_reason_code text,
  command_rejection_user_facing_reason text,
  command_identity_reason_code text,
  command_identity_rule_reference text,
  reason text,
  payload_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT craftsman_profile_publication_commands_revision_valid CHECK (
    expected_revision >= 0 AND resulting_revision > 0
  ),
  CONSTRAINT craftsman_profile_publication_commands_fingerprint_valid CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT craftsman_profile_publication_commands_actor_shape CHECK (
    (
      actor_kind = 'OWNER'
      AND actor_user_id IS NOT NULL
      AND actor_system_reference IS NULL
      AND actor_capability IS NULL
      AND authorization_session_hash IS NULL
      AND mfa_factor_id IS NULL
      AND mfa_authenticated_at IS NULL
      AND correlation_id IS NULL
      AND audit_event_id IS NULL
      AND reason IS NULL
    ) OR (
      actor_kind = 'ADMIN'
      AND actor_user_id IS NOT NULL
      AND actor_system_reference IS NULL
      AND actor_capability IN ('admin.profiles.review', 'admin.profiles.moderate')
      AND authorization_session_hash IS NULL
      AND mfa_factor_id IS NOT NULL
      AND mfa_authenticated_at IS NOT NULL
      AND correlation_id IS NOT NULL
      AND audit_event_id IS NOT NULL
      AND audit_reason_is_safe(reason)
    ) OR (
      actor_kind = 'SYSTEM'
      AND actor_user_id IS NULL
      AND actor_system_reference = 'profile-service:identity-change'
      AND actor_capability IS NULL
      AND authorization_session_hash IS NULL
      AND mfa_factor_id IS NULL
      AND mfa_authenticated_at IS NULL
      AND correlation_id IS NULL
      AND audit_event_id IS NOT NULL
      AND reason IS NULL
    )
  ),
  CONSTRAINT craftsman_profile_publication_commands_rejection_shape CHECK (
    (review_state = 'REJECTED') =
      (rejection_reason_code IS NOT NULL
       AND rejection_user_facing_reason IS NOT NULL
       AND rejected_by_user_id IS NOT NULL
       AND rejected_at IS NOT NULL)
  ),
  CONSTRAINT craftsman_profile_publication_commands_approval_shape CHECK (
    (review_state = 'APPROVED') =
      (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT craftsman_profile_publication_commands_moderation_shape CHECK (
    (moderation_state <> 'ALLOWED') =
      (moderation_reason_category IS NOT NULL
       AND moderation_reason_code IS NOT NULL
       AND moderation_policy_version IS NOT NULL
       AND moderated_by_user_id IS NOT NULL
       AND moderated_at IS NOT NULL)
  ),
  CONSTRAINT craftsman_profile_publication_commands_codes_safe CHECK (
    (rejection_reason_code IS NULL OR rejection_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (moderation_reason_category IS NULL OR moderation_reason_category ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (moderation_reason_code IS NULL OR moderation_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (moderation_policy_version IS NULL OR moderation_policy_version ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (identity_review_reason_code IS NULL OR identity_review_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (identity_review_rule_reference IS NULL OR identity_review_rule_reference ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (command_reason_category IS NULL OR command_reason_category ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (command_reason_code IS NULL OR command_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (command_policy_version IS NULL OR command_policy_version ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (command_rejection_reason_code IS NULL OR command_rejection_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (command_identity_reason_code IS NULL OR command_identity_reason_code ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
    AND (command_identity_rule_reference IS NULL OR command_identity_rule_reference ~ '^[A-Z][A-Z0-9_.:-]{2,95}$')
  ),
  CONSTRAINT craftsman_profile_publication_commands_user_reason_safe CHECK (
    (rejection_user_facing_reason IS NULL OR (
       audit_reason_is_safe(rejection_user_facing_reason)
       AND rejection_user_facing_reason !~* '(https?://|www\.)'
       AND rejection_user_facing_reason !~* '[^[:space:]@]+@[^[:space:]@]+\.[[:alpha:]]{2,}'
       AND rejection_user_facing_reason !~* '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)'
     ))
    AND (command_rejection_user_facing_reason IS NULL OR (
       audit_reason_is_safe(command_rejection_user_facing_reason)
       AND command_rejection_user_facing_reason !~* '(https?://|www\.)'
       AND command_rejection_user_facing_reason !~* '[^[:space:]@]+@[^[:space:]@]+\.[[:alpha:]]{2,}'
       AND command_rejection_user_facing_reason !~* '(^|[^0-9])(\+|00)?[0-9]([[:space:]()./-]*[0-9]){6,}([^0-9]|$)'
     ))
  ),
  CONSTRAINT craftsman_profile_publication_commands_input_shape CHECK (
    ((command_kind IN ('MODERATION_HIDE', 'MODERATION_RESTRICT', 'MODERATION_RESTORE'))
      = (command_reason_category IS NOT NULL
         AND command_reason_code IS NOT NULL
         AND command_policy_version IS NOT NULL))
    AND ((command_kind = 'ADMIN_REJECT')
      = (command_rejection_reason_code IS NOT NULL
         AND command_rejection_user_facing_reason IS NOT NULL))
    AND ((command_kind = 'IDENTITY_REVIEW_REQUIRED')
      = (command_identity_reason_code IS NOT NULL
         AND command_identity_rule_reference IS NOT NULL))
  )
);

CREATE INDEX craftsman_profile_publication_commands_profile_created_idx
  ON craftsman_profile_publication_commands (
    craftsman_profile_id, created_at DESC, command_id
  );

CREATE TABLE craftsman_profile_publication_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE
    REFERENCES craftsman_profile_publication_commands(command_id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  review_state craftsman_profile_review_state NOT NULL,
  owner_visibility craftsman_profile_owner_visibility NOT NULL,
  moderation_state craftsman_profile_moderation_state NOT NULL,
  approved_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  rejection_reason_code text,
  rejection_user_facing_reason text,
  rejected_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  moderation_reason_category text,
  moderation_reason_code text,
  moderation_policy_version text,
  moderated_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  moderated_at timestamptz,
  identity_review_reason_code text,
  identity_review_rule_reference text,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT craftsman_profile_publication_revisions_profile_revision_key
    UNIQUE (craftsman_profile_id, revision),
  CONSTRAINT craftsman_profile_publication_revisions_revision_positive
    CHECK (revision > 0),
  CONSTRAINT craftsman_profile_publication_revisions_rejection_shape CHECK (
    (review_state = 'REJECTED') =
      (rejection_reason_code IS NOT NULL
       AND rejection_user_facing_reason IS NOT NULL
       AND rejected_by_user_id IS NOT NULL
       AND rejected_at IS NOT NULL)
  ),
  CONSTRAINT craftsman_profile_publication_revisions_approval_shape CHECK (
    (review_state = 'APPROVED') =
      (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT craftsman_profile_publication_revisions_moderation_shape CHECK (
    (moderation_state <> 'ALLOWED') =
      (moderation_reason_category IS NOT NULL
       AND moderation_reason_code IS NOT NULL
       AND moderation_policy_version IS NOT NULL
       AND moderated_by_user_id IS NOT NULL
       AND moderated_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION validate_craftsman_profile_publication_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_id uuid;
  owner_state user_account_state;
  current_revision integer := 0;
  current_review craftsman_profile_review_state := 'DRAFT';
  current_owner_visibility craftsman_profile_owner_visibility := 'HIDDEN';
  current_moderation craftsman_profile_moderation_state := 'ALLOWED';
  current_row craftsman_profile_publication_revisions%ROWTYPE;
  now_at timestamptz := clock_timestamp();
  authenticated_factor_id uuid;
  authenticated_mfa_at timestamptz;
  missing_requirements text[];
  requested_owner_visibility craftsman_profile_owner_visibility := NEW.owner_visibility;
  requested_rejection_reason_code text := NEW.command_rejection_reason_code;
  requested_rejection_user_facing_reason text := NEW.command_rejection_user_facing_reason;
  requested_moderation_reason_category text := NEW.command_reason_category;
  requested_moderation_reason_code text := NEW.command_reason_code;
  requested_moderation_policy_version text := NEW.command_policy_version;
  requested_identity_review_reason_code text := NEW.command_identity_reason_code;
  requested_identity_review_rule_reference text := NEW.command_identity_rule_reference;
BEGIN
  SELECT profile.owner_user_id, owner.account_state
    INTO owner_id, owner_state
  FROM craftsman_profiles profile
  JOIN users owner ON owner.id = profile.owner_user_id
  WHERE profile.id = NEW.craftsman_profile_id
  FOR UPDATE OF profile, owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'craftsman profile required for publication command';
  END IF;

  SELECT * INTO current_row
  FROM craftsman_profile_publication_revisions revision
  WHERE revision.craftsman_profile_id = NEW.craftsman_profile_id
  ORDER BY revision.revision DESC
  LIMIT 1;
  IF FOUND THEN
    current_revision := current_row.revision;
    current_review := current_row.review_state;
    current_owner_visibility := current_row.owner_visibility;
    current_moderation := current_row.moderation_state;
  END IF;
  IF NEW.expected_revision <> current_revision THEN
    RAISE EXCEPTION 'publication command has stale revision';
  END IF;

  IF NEW.actor_kind = 'OWNER' THEN
    IF NEW.actor_user_id IS DISTINCT FROM owner_id OR owner_state <> 'ACTIVE'
       OR NEW.command_kind NOT IN ('SUBMIT_REVIEW', 'SET_OWNER_VISIBILITY') THEN
      RAISE EXCEPTION 'active owner required for publication command';
    END IF;
  ELSIF NEW.actor_kind = 'ADMIN' THEN
    IF NEW.command_kind NOT IN (
      'ADMIN_APPROVE', 'ADMIN_REJECT', 'MODERATION_HIDE',
      'MODERATION_RESTRICT', 'MODERATION_RESTORE'
    ) THEN
      RAISE EXCEPTION 'invalid admin publication command';
    END IF;
    SELECT privileged.mfa_factor_id, privileged.mfa_authenticated_at
      INTO authenticated_factor_id, authenticated_mfa_at
    FROM admin_privileged_sessions privileged
    JOIN auth_sessions session
      ON session.session_id_hash = privileged.session_id_hash
     AND session.user_id = privileged.user_id
    JOIN users actor ON actor.id = privileged.user_id
    JOIN admin_mfa_factors factor
      ON factor.id = privileged.mfa_factor_id
     AND factor.user_id = privileged.user_id
    JOIN admin_role_grants role_grant
      ON role_grant.user_id = privileged.user_id
     AND role_grant.role IN ('ADMIN', 'SUPER_ADMIN')
     AND role_grant.revoked_at IS NULL
    WHERE privileged.session_id_hash = NEW.authorization_session_hash
      AND privileged.user_id = NEW.actor_user_id
      AND privileged.revoked_at IS NULL
      AND privileged.expires_at > now_at
      AND session.revoked_at IS NULL
      AND session.expires_at > now_at
      AND actor.account_state = 'ACTIVE'
      AND factor.revoked_at IS NULL
      AND privileged.mfa_authenticated_at >= now_at - interval '10 minutes'
    ORDER BY role_grant.role DESC
    LIMIT 1
    FOR UPDATE OF privileged, session, actor, factor, role_grant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'fresh MFA-backed admin authorization required';
    END IF;
    IF NEW.command_kind IN ('ADMIN_APPROVE', 'ADMIN_REJECT')
       AND NEW.actor_capability <> 'admin.profiles.review' THEN
      RAISE EXCEPTION 'profile review capability required';
    END IF;
    IF NEW.command_kind IN (
      'MODERATION_HIDE', 'MODERATION_RESTRICT', 'MODERATION_RESTORE'
    ) AND NEW.actor_capability <> 'admin.profiles.moderate' THEN
      RAISE EXCEPTION 'profile moderation capability required';
    END IF;
    NEW.mfa_factor_id := authenticated_factor_id;
    NEW.mfa_authenticated_at := authenticated_mfa_at;
    NEW.authorization_session_hash := NULL;
  ELSE
    IF NEW.command_kind <> 'IDENTITY_REVIEW_REQUIRED'
       OR NEW.actor_system_reference <> 'profile-service:identity-change' THEN
      RAISE EXCEPTION 'trusted identity-review system hook required';
    END IF;
  END IF;

  -- Default to preserving all independent axes and current decision facts.
  NEW.review_state := current_review;
  NEW.owner_visibility := current_owner_visibility;
  NEW.moderation_state := current_moderation;
  NEW.approved_by_user_id := current_row.approved_by_user_id;
  NEW.approved_at := current_row.approved_at;
  NEW.rejection_reason_code := current_row.rejection_reason_code;
  NEW.rejection_user_facing_reason := current_row.rejection_user_facing_reason;
  NEW.rejected_by_user_id := current_row.rejected_by_user_id;
  NEW.rejected_at := current_row.rejected_at;
  NEW.moderation_reason_category := current_row.moderation_reason_category;
  NEW.moderation_reason_code := current_row.moderation_reason_code;
  NEW.moderation_policy_version := current_row.moderation_policy_version;
  NEW.moderated_by_user_id := current_row.moderated_by_user_id;
  NEW.moderated_at := current_row.moderated_at;
  NEW.identity_review_reason_code := current_row.identity_review_reason_code;
  NEW.identity_review_rule_reference := current_row.identity_review_rule_reference;

  IF NEW.command_kind = 'SUBMIT_REVIEW' THEN
    IF current_review NOT IN ('DRAFT', 'REJECTED') THEN
      RAISE EXCEPTION 'profile cannot be submitted from current review state';
    END IF;
    missing_requirements := craftsman_profile_missing_publication_requirements(
      NEW.craftsman_profile_id
    );
    IF cardinality(missing_requirements) <> 0 THEN
      RAISE EXCEPTION 'profile publication minimum is incomplete';
    END IF;
    NEW.review_state := 'PENDING';
    NEW.approved_by_user_id := NULL;
    NEW.approved_at := NULL;
    NEW.rejection_reason_code := NULL;
    NEW.rejection_user_facing_reason := NULL;
    NEW.rejected_by_user_id := NULL;
    NEW.rejected_at := NULL;
    NEW.identity_review_reason_code := NULL;
    NEW.identity_review_rule_reference := NULL;
  ELSIF NEW.command_kind = 'SET_OWNER_VISIBILITY' THEN
    -- The repository-supplied target is the only state field this command controls.
    IF requested_owner_visibility IS NOT DISTINCT FROM current_owner_visibility THEN
      RAISE EXCEPTION 'owner visibility command must change the preference';
    END IF;
    NEW.owner_visibility := requested_owner_visibility;
  ELSIF NEW.command_kind = 'ADMIN_APPROVE' THEN
    IF current_review <> 'PENDING' THEN
      RAISE EXCEPTION 'only a pending profile may be approved';
    END IF;
    missing_requirements := craftsman_profile_missing_publication_requirements(
      NEW.craftsman_profile_id
    );
    IF cardinality(missing_requirements) <> 0 THEN
      RAISE EXCEPTION 'profile publication minimum is incomplete';
    END IF;
    NEW.review_state := 'APPROVED';
    NEW.approved_by_user_id := NEW.actor_user_id;
    NEW.approved_at := now_at;
    NEW.rejection_reason_code := NULL;
    NEW.rejection_user_facing_reason := NULL;
    NEW.rejected_by_user_id := NULL;
    NEW.rejected_at := NULL;
    NEW.identity_review_reason_code := NULL;
    NEW.identity_review_rule_reference := NULL;
  ELSIF NEW.command_kind = 'ADMIN_REJECT' THEN
    IF current_review <> 'PENDING' OR requested_rejection_reason_code IS NULL
       OR requested_rejection_user_facing_reason IS NULL THEN
      RAISE EXCEPTION 'pending profile and stable rejection reason required';
    END IF;
    NEW.review_state := 'REJECTED';
    NEW.approved_by_user_id := NULL;
    NEW.approved_at := NULL;
    NEW.rejection_reason_code := requested_rejection_reason_code;
    NEW.rejection_user_facing_reason := requested_rejection_user_facing_reason;
    NEW.rejected_by_user_id := NEW.actor_user_id;
    NEW.rejected_at := now_at;
    NEW.identity_review_reason_code := NULL;
    NEW.identity_review_rule_reference := NULL;
  ELSIF NEW.command_kind IN ('MODERATION_HIDE', 'MODERATION_RESTRICT') THEN
    IF requested_moderation_reason_category IS NULL
       OR requested_moderation_reason_code IS NULL
       OR requested_moderation_policy_version IS NULL THEN
      RAISE EXCEPTION 'stable moderation reason and policy version required';
    END IF;
    NEW.moderation_state := CASE NEW.command_kind
      WHEN 'MODERATION_HIDE' THEN 'HIDDEN'
      ELSE 'RESTRICTED'
    END;
    NEW.moderation_reason_category := requested_moderation_reason_category;
    NEW.moderation_reason_code := requested_moderation_reason_code;
    NEW.moderation_policy_version := requested_moderation_policy_version;
    NEW.moderated_by_user_id := NEW.actor_user_id;
    NEW.moderated_at := now_at;
  ELSIF NEW.command_kind = 'MODERATION_RESTORE' THEN
    IF current_moderation = 'ALLOWED' OR requested_moderation_reason_category IS NULL
       OR requested_moderation_reason_code IS NULL
       OR requested_moderation_policy_version IS NULL THEN
      RAISE EXCEPTION 'restricted profile and stable restore reason required';
    END IF;
    NEW.moderation_state := 'ALLOWED';
    NEW.moderation_reason_category := NULL;
    NEW.moderation_reason_code := NULL;
    NEW.moderation_policy_version := NULL;
    NEW.moderated_by_user_id := NULL;
    NEW.moderated_at := NULL;
  ELSE
    IF current_review <> 'APPROVED'
       OR requested_identity_review_reason_code IS NULL
       OR requested_identity_review_rule_reference IS NULL THEN
      RAISE EXCEPTION 'approved profile and explicit identity rule required';
    END IF;
    NEW.review_state := 'PENDING';
    NEW.approved_by_user_id := NULL;
    NEW.approved_at := NULL;
    NEW.rejection_reason_code := NULL;
    NEW.rejection_user_facing_reason := NULL;
    NEW.rejected_by_user_id := NULL;
    NEW.rejected_at := NULL;
    NEW.identity_review_reason_code := requested_identity_review_reason_code;
    NEW.identity_review_rule_reference := requested_identity_review_rule_reference;
  END IF;

  NEW.resulting_revision := current_revision + 1;
  NEW.created_at := now_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profile_publication_commands_insert_guard
BEFORE INSERT ON craftsman_profile_publication_commands
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_profile_publication_command();

CREATE OR REPLACE FUNCTION validate_craftsman_profile_publication_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE source craftsman_profile_publication_commands%ROWTYPE;
BEGIN
  SELECT * INTO source
  FROM craftsman_profile_publication_commands
  WHERE command_id = NEW.command_id
  FOR UPDATE;
  IF NOT FOUND OR source.craftsman_profile_id <> NEW.craftsman_profile_id THEN
    RAISE EXCEPTION 'publication revision requires command provenance';
  END IF;
  NEW.revision := source.resulting_revision;
  NEW.review_state := source.review_state;
  NEW.owner_visibility := source.owner_visibility;
  NEW.moderation_state := source.moderation_state;
  NEW.approved_by_user_id := source.approved_by_user_id;
  NEW.approved_at := source.approved_at;
  NEW.rejection_reason_code := source.rejection_reason_code;
  NEW.rejection_user_facing_reason := source.rejection_user_facing_reason;
  NEW.rejected_by_user_id := source.rejected_by_user_id;
  NEW.rejected_at := source.rejected_at;
  NEW.moderation_reason_category := source.moderation_reason_category;
  NEW.moderation_reason_code := source.moderation_reason_code;
  NEW.moderation_policy_version := source.moderation_policy_version;
  NEW.moderated_by_user_id := source.moderated_by_user_id;
  NEW.moderated_at := source.moderated_at;
  NEW.identity_review_reason_code := source.identity_review_reason_code;
  NEW.identity_review_rule_reference := source.identity_review_rule_reference;
  NEW.changed_at := source.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craftsman_profile_publication_revisions_insert_guard
BEFORE INSERT ON craftsman_profile_publication_revisions
FOR EACH ROW EXECUTE FUNCTION validate_craftsman_profile_publication_revision();

CREATE OR REPLACE FUNCTION ensure_craftsman_profile_publication_command_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit audit_events%ROWTYPE;
  previous_review craftsman_profile_review_state := 'DRAFT';
  previous_moderation craftsman_profile_moderation_state := 'ALLOWED';
  expected_action text;
  expected_changes jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM craftsman_profile_publication_revisions revision
    WHERE revision.command_id = NEW.command_id
      AND revision.craftsman_profile_id = NEW.craftsman_profile_id
      AND revision.revision = NEW.resulting_revision
  ) THEN
    RAISE EXCEPTION 'publication command requires exact revision effect';
  END IF;
  IF NEW.actor_kind = 'OWNER' THEN
    IF NEW.audit_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'owner publication command cannot claim privileged audit';
    END IF;
    RETURN NULL;
  END IF;

  SELECT revision.review_state, revision.moderation_state
    INTO previous_review, previous_moderation
  FROM craftsman_profile_publication_revisions revision
  WHERE revision.craftsman_profile_id = NEW.craftsman_profile_id
    AND revision.revision = NEW.expected_revision;
  previous_review := COALESCE(previous_review, 'DRAFT');
  previous_moderation := COALESCE(previous_moderation, 'ALLOWED');

  SELECT * INTO audit FROM audit_events WHERE event_id = NEW.audit_event_id;
  expected_action := CASE NEW.command_kind
    WHEN 'ADMIN_APPROVE' THEN 'admin.profile.approved'
    WHEN 'ADMIN_REJECT' THEN 'admin.profile.rejected'
    WHEN 'MODERATION_HIDE' THEN 'admin.profile.hidden'
    WHEN 'MODERATION_RESTRICT' THEN 'admin.profile.restricted'
    WHEN 'MODERATION_RESTORE' THEN 'admin.profile.restored'
    WHEN 'IDENTITY_REVIEW_REQUIRED' THEN 'system.profile.identity_review_required'
  END;
  expected_changes := CASE
    WHEN NEW.command_kind IN (
      'MODERATION_HIDE', 'MODERATION_RESTRICT', 'MODERATION_RESTORE'
    ) THEN jsonb_build_object(
      'restriction_state', jsonb_build_object(
        'before', previous_moderation::text,
        'after', NEW.moderation_state::text
      )
    )
    ELSE jsonb_build_object(
      'profile_state', jsonb_build_object(
        'before', previous_review::text,
        'after', NEW.review_state::text
      )
    )
  END;
  IF NOT FOUND
     OR audit.action_type IS DISTINCT FROM expected_action
     OR audit.target_type <> 'CRAFTSMAN_PROFILE'
     OR audit.target_id <> NEW.craftsman_profile_id::text
     OR audit.changes IS DISTINCT FROM expected_changes
     OR (
       NEW.actor_kind = 'ADMIN' AND (
         audit.category <> 'PRIVILEGED_COMMAND'
         OR audit.actor_kind <> 'AUTHENTICATED_USER'
         OR audit.actor_user_id IS DISTINCT FROM NEW.actor_user_id
         OR audit.actor_capability IS DISTINCT FROM NEW.actor_capability
         OR audit.correlation_id IS DISTINCT FROM NEW.correlation_id
         OR audit.reason IS DISTINCT FROM NEW.reason
       )
     )
     OR (
       NEW.actor_kind = 'SYSTEM' AND (
         audit.category <> 'SECURITY_EVENT'
         OR audit.actor_kind <> 'SYSTEM'
         OR audit.actor_system_reference IS DISTINCT FROM NEW.actor_system_reference
         OR audit.correlation_id IS DISTINCT FROM NEW.command_id
       )
     ) THEN
    RAISE EXCEPTION 'admin/system publication command requires exact audit effect';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER craftsman_profile_publication_command_effect_required
AFTER INSERT ON craftsman_profile_publication_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_craftsman_profile_publication_command_effect();

CREATE OR REPLACE FUNCTION reject_craftsman_profile_publication_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'craftsman profile publication history is append-only';
END;
$$;
CREATE TRIGGER craftsman_profile_publication_commands_append_only
BEFORE UPDATE OR DELETE ON craftsman_profile_publication_commands
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_profile_publication_history_mutation();
CREATE TRIGGER craftsman_profile_publication_revisions_append_only
BEFORE UPDATE OR DELETE ON craftsman_profile_publication_revisions
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_profile_publication_history_mutation();

CREATE VIEW current_craftsman_profile_publications AS
WITH current_revision AS (
  SELECT DISTINCT ON (revision.craftsman_profile_id) revision.*
  FROM craftsman_profile_publication_revisions revision
  ORDER BY revision.craftsman_profile_id, revision.revision DESC
)
SELECT
  profile.id AS craftsman_profile_id,
  profile.owner_user_id,
  COALESCE(revision.revision, 0) AS revision,
  COALESCE(revision.review_state, 'DRAFT')::craftsman_profile_review_state
    AS review_state,
  COALESCE(revision.owner_visibility, 'HIDDEN')::craftsman_profile_owner_visibility
    AS owner_visibility,
  COALESCE(revision.moderation_state, 'ALLOWED')::craftsman_profile_moderation_state
    AS moderation_state,
  revision.approved_by_user_id,
  revision.approved_at,
  revision.rejection_reason_code,
  revision.rejection_user_facing_reason,
  revision.rejected_by_user_id,
  revision.rejected_at,
  revision.moderation_reason_category,
  revision.moderation_reason_code,
  revision.moderation_policy_version,
  revision.moderated_by_user_id,
  revision.moderated_at,
  revision.identity_review_reason_code,
  revision.identity_review_rule_reference,
  COALESCE(
    craftsman_profile_missing_publication_requirements(profile.id),
    ARRAY['VALID_IDENTITY', 'ABOUT', 'ACTIVE_PROFESSION_WITH_DECLARED_LEVEL',
      'BASE_MUNICIPALITY', 'NORMAL_RADIUS']::text[]
  ) AS missing_requirements,
  COALESCE((
    owner.account_state = 'ACTIVE'
    AND revision.review_state = 'APPROVED'
    AND revision.owner_visibility = 'PUBLIC'
    AND revision.moderation_state = 'ALLOWED'
    AND cardinality(craftsman_profile_missing_publication_requirements(profile.id)) = 0
  ), false) AS effectively_public,
  revision.changed_at
FROM craftsman_profiles profile
JOIN users owner ON owner.id = profile.owner_user_id
LEFT JOIN current_revision revision ON revision.craftsman_profile_id = profile.id;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_valid CHECK (
  (
    actor_kind = 'AUTHENTICATED_USER'
    AND actor_user_id IS NOT NULL
    AND actor_system_reference IS NULL
    AND actor_capability IS NOT NULL
    AND actor_capability IN (
      'admin.access',
      'admin.credentials.review',
      'admin.disputes.manage',
      'admin.jobs.correct',
      'admin.profiles.review',
      'admin.profiles.moderate',
      'admin.reviews.moderate',
      'admin.sensitive.read',
      'admin.users.manage',
      'admin.roles.manage'
    )
  ) OR (
    actor_kind = 'SYSTEM'
    AND actor_user_id IS NULL
    AND actor_system_reference IS NOT NULL
    AND actor_system_reference ~ '^[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND actor_capability IS NULL
  )
);

COMMENT ON VIEW current_craftsman_profile_publications IS
  'Authoritative private publication/readiness boundary only. It exposes no public profile projection and dynamically fails closed when D08 minimum, owner ACTIVE state, approval, owner preference or moderation no longer permits publication.';
COMMENT ON TABLE craftsman_profile_publication_revisions IS
  'Immutable independent review, owner-visibility and moderation snapshots. Moderation restore preserves the last owner preference; low-risk edits do not mutate approval.';
