CREATE TYPE taxonomy_suggestion_kind AS ENUM ('PROFESSION', 'SERVICE');
CREATE TYPE taxonomy_suggestion_decision AS ENUM (
  'APPROVED_AS_NEW', 'MAPPED_TO_EXISTING', 'REJECTED'
);

CREATE TABLE taxonomy_suggestions (
  suggestion_id uuid PRIMARY KEY,
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requester_craftsman_profile_id uuid NOT NULL
    REFERENCES craftsman_profiles(id) ON DELETE RESTRICT,
  proposed_name text NOT NULL CHECK (length(btrim(proposed_name)) BETWEEN 2 AND 100),
  proposed_description text NOT NULL
    CHECK (length(btrim(proposed_description)) BETWEEN 10 AND 1000),
  normalized_proposed_name text NOT NULL
    CHECK (length(normalized_proposed_name) BETWEEN 2 AND 100),
  suggested_kind taxonomy_suggestion_kind,
  submission_command_id uuid NOT NULL UNIQUE,
  submission_fingerprint char(64) NOT NULL
    CHECK (submission_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX taxonomy_suggestions_pending_owner_idx
  ON taxonomy_suggestions (requester_craftsman_profile_id, created_at, suggestion_id);
CREATE INDEX taxonomy_suggestions_normalized_name_idx
  ON taxonomy_suggestions (normalized_proposed_name);

CREATE TABLE taxonomy_suggestion_decisions (
  decision_id uuid PRIMARY KEY,
  suggestion_id uuid NOT NULL UNIQUE
    REFERENCES taxonomy_suggestions(suggestion_id) ON DELETE RESTRICT,
  decision taxonomy_suggestion_decision NOT NULL,
  decided_by_admin_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  admin_decision_note text,
  resolved_taxonomy_kind taxonomy_suggestion_kind,
  resolved_taxonomy_code text,
  resolved_taxonomy_label text,
  resulting_release_id uuid REFERENCES profession_taxonomy_releases(release_id),
  add_proposed_name_as_alias boolean NOT NULL DEFAULT false,
  command_id uuid NOT NULL UNIQUE,
  command_fingerprint char(64) NOT NULL
    CHECK (command_fingerprint ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT taxonomy_suggestion_decision_shape CHECK (
    (decision = 'REJECTED' AND resolved_taxonomy_kind IS NULL
      AND resolved_taxonomy_code IS NULL AND resolved_taxonomy_label IS NULL
      AND resulting_release_id IS NULL
      AND add_proposed_name_as_alias = false
      AND length(btrim(admin_decision_note)) BETWEEN 8 AND 500)
    OR
    (decision = 'MAPPED_TO_EXISTING' AND resolved_taxonomy_kind IS NOT NULL
      AND resolved_taxonomy_code IS NOT NULL
      AND resolved_taxonomy_label IS NOT NULL
      AND length(btrim(resolved_taxonomy_label)) BETWEEN 2 AND 120
      AND ((add_proposed_name_as_alias = false AND resulting_release_id IS NULL)
        OR (add_proposed_name_as_alias = true AND resulting_release_id IS NOT NULL))
      AND length(btrim(admin_decision_note)) BETWEEN 8 AND 500)
    OR
    (decision = 'APPROVED_AS_NEW' AND resolved_taxonomy_kind IS NOT NULL
      AND resolved_taxonomy_code IS NOT NULL AND resulting_release_id IS NOT NULL
      AND resolved_taxonomy_label IS NOT NULL
      AND length(btrim(resolved_taxonomy_label)) BETWEEN 2 AND 120
      AND add_proposed_name_as_alias = false
      AND (admin_decision_note IS NULL
        OR length(btrim(admin_decision_note)) BETWEEN 3 AND 500))
  ),
  CONSTRAINT taxonomy_suggestion_resolved_code_shape CHECK (
    resolved_taxonomy_code IS NULL OR
    (resolved_taxonomy_kind = 'PROFESSION'
      AND resolved_taxonomy_code ~ '^PROF:[A-Z][A-Z0-9_]{1,62}$') OR
    (resolved_taxonomy_kind = 'SERVICE'
      AND resolved_taxonomy_code ~ '^SERV:[A-Z][A-Z0-9_]{1,62}$')
  )
);
CREATE INDEX taxonomy_suggestion_decisions_admin_idx
  ON taxonomy_suggestion_decisions (decided_by_admin_id, decided_at);

CREATE VIEW current_taxonomy_suggestions
WITH (security_invoker = true)
AS
SELECT suggestion.suggestion_id AS id,
  suggestion.requester_user_id,
  suggestion.requester_craftsman_profile_id,
  suggestion.proposed_name, suggestion.proposed_description,
  suggestion.normalized_proposed_name, suggestion.suggested_kind,
  COALESCE(decision.decision::text, 'PENDING') AS state,
  CASE WHEN decision.decision_id IS NULL THEN 1 ELSE 2 END AS revision,
  suggestion.created_at, decision.decided_at,
  decision.decided_by_admin_id, decision.admin_decision_note,
  decision.resolved_taxonomy_kind, decision.resolved_taxonomy_code,
  decision.resolved_taxonomy_label,
  decision.resulting_release_id
FROM taxonomy_suggestions suggestion
LEFT JOIN taxonomy_suggestion_decisions decision
  ON decision.suggestion_id = suggestion.suggestion_id;

CREATE TRIGGER taxonomy_suggestions_immutable
BEFORE UPDATE OR DELETE ON taxonomy_suggestions
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();
CREATE TRIGGER taxonomy_suggestion_decisions_immutable
BEFORE UPDATE OR DELETE ON taxonomy_suggestion_decisions
FOR EACH ROW EXECUTE FUNCTION reject_craftsman_capability_history_mutation();

CREATE FUNCTION capture_taxonomy_suggestion_submitted_notification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient record;
BEGIN
  FOR recipient IN
    SELECT DISTINCT grant_row.user_id
    FROM admin_role_grants grant_row
    JOIN users admin_user ON admin_user.id = grant_row.user_id
    WHERE grant_row.revoked_at IS NULL
      AND grant_row.role IN ('ADMIN', 'SUPER_ADMIN')
      AND admin_user.account_state = 'ACTIVE'
  LOOP
    PERFORM insert_exact_notification_outbox_event(
      'taxonomy-suggestion:' || NEW.suggestion_id::text || ':submitted:' || recipient.user_id::text,
      'taxonomy.suggestion.submitted', NEW.created_at,
      'TAXONOMY_SUGGESTION', NEW.suggestion_id::text,
      jsonb_build_object('recipient_user_id', recipient.user_id::text,
        'suggestion_id', NEW.suggestion_id::text),
      'taxonomy.suggestion.submitted', NEW.submission_command_id::text, NEW.created_at
    );
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER taxonomy_suggestion_submitted_notification
AFTER INSERT ON taxonomy_suggestions
FOR EACH ROW EXECUTE FUNCTION capture_taxonomy_suggestion_submitted_notification();

CREATE FUNCTION capture_taxonomy_suggestion_decision_notification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient_id uuid;
DECLARE event_name text;
BEGIN
  SELECT requester_user_id INTO recipient_id
  FROM taxonomy_suggestions WHERE suggestion_id = NEW.suggestion_id;
  IF recipient_id IS NULL THEN RAISE EXCEPTION 'taxonomy suggestion requester required'; END IF;
  event_name := CASE NEW.decision
    WHEN 'APPROVED_AS_NEW' THEN 'taxonomy.suggestion.approved'
    WHEN 'MAPPED_TO_EXISTING' THEN 'taxonomy.suggestion.mapped'
    ELSE 'taxonomy.suggestion.rejected'
  END;
  PERFORM insert_exact_notification_outbox_event(
    'taxonomy-suggestion:' || NEW.suggestion_id::text || ':decision',
    event_name, NEW.decided_at, 'TAXONOMY_SUGGESTION', NEW.suggestion_id::text,
    jsonb_build_object('recipient_user_id', recipient_id::text,
      'suggestion_id', NEW.suggestion_id::text,
      'outcome', NEW.decision::text,
      'resolved_taxonomy_code', NEW.resolved_taxonomy_code),
    event_name, NEW.command_id::text, NEW.decided_at
  );
  RETURN NULL;
END;
$$;
CREATE TRIGGER taxonomy_suggestion_decision_notification
AFTER INSERT ON taxonomy_suggestion_decisions
FOR EACH ROW EXECUTE FUNCTION capture_taxonomy_suggestion_decision_notification();

ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_valid CHECK (
  (
    actor_kind = 'AUTHENTICATED_USER'
    AND actor_user_id IS NOT NULL
    AND actor_system_reference IS NULL
    AND actor_capability IS NOT NULL
    AND actor_capability IN (
      'admin.access', 'admin.credentials.review', 'admin.disputes.manage',
      'admin.jobs.correct', 'admin.profiles.review', 'admin.profiles.moderate',
      'admin.privacy.manage', 'admin.reviews.moderate', 'admin.sensitive.read',
      'admin.taxonomy.manage', 'admin.users.manage', 'admin.roles.manage'
    )
  ) OR (
    actor_kind = 'SYSTEM'
    AND actor_user_id IS NULL
    AND actor_system_reference IS NOT NULL
    AND actor_system_reference ~ '^[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND actor_capability IS NULL
  )
);
