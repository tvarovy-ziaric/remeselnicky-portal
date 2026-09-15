CREATE TYPE analytics_traffic_class AS ENUM ('REAL', 'INTERNAL', 'TEST');
CREATE TYPE r3_analytics_delivery_state AS ENUM (
  'PENDING', 'PROCESSING', 'DELIVERED', 'TERMINAL_INVALID', 'TERMINAL_SKIPPED'
);
CREATE TYPE r3_analytics_initiator AS ENUM ('USER', 'SYSTEM');

-- Server/admin-owned classification history. No owner/public mutation API exists.
-- Absence deliberately means REAL; synthetic fixtures must append TEST explicitly.
CREATE TABLE user_analytics_traffic_classification_events (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  traffic_class analytics_traffic_class NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, revision)
);
CREATE VIEW current_user_analytics_traffic_classifications AS
SELECT DISTINCT ON (event.user_id)
  event.user_id, event.revision, event.traffic_class, event.changed_at
FROM user_analytics_traffic_classification_events event
ORDER BY event.user_id, event.revision DESC;

CREATE FUNCTION validate_user_analytics_traffic_classification_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_revision integer;
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'analytics traffic user required'; END IF;
  SELECT max(event.revision) INTO prior_revision
  FROM user_analytics_traffic_classification_events event
  WHERE event.user_id = NEW.user_id;
  IF NEW.revision <> coalesce(prior_revision, 0) + 1 THEN
    RAISE EXCEPTION 'analytics traffic classification revision is stale';
  END IF;
  NEW.changed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_analytics_traffic_classification_events_guard
BEFORE INSERT ON user_analytics_traffic_classification_events
FOR EACH ROW EXECUTE FUNCTION validate_user_analytics_traffic_classification_event();

CREATE FUNCTION reject_user_analytics_traffic_classification_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'analytics traffic classification is append-only'; END;
$$;
CREATE TRIGGER user_analytics_traffic_classification_events_append_only
BEFORE UPDATE OR DELETE ON user_analytics_traffic_classification_events
FOR EACH ROW EXECUTE FUNCTION reject_user_analytics_traffic_classification_mutation();

CREATE TABLE r3_analytics_event_deliveries (
  source_event_id uuid PRIMARY KEY
    REFERENCES domain_outbox_events(event_id) ON DELETE RESTRICT,
  state r3_analytics_delivery_state NOT NULL DEFAULT 'PENDING',
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  delivered_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT r3_analytics_delivery_error_safe CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'
  ),
  CONSTRAINT r3_analytics_delivery_shape CHECK (
    (state = 'PENDING' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND delivered_at IS NULL AND terminal_at IS NULL)
    OR (state = 'PROCESSING' AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND delivered_at IS NULL
      AND terminal_at IS NULL)
    OR (state = 'DELIVERED' AND lease_token IS NULL
      AND lease_expires_at IS NULL AND delivered_at IS NOT NULL
      AND terminal_at IS NULL AND last_error_code IS NULL)
    OR (state IN ('TERMINAL_INVALID', 'TERMINAL_SKIPPED')
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND delivered_at IS NULL AND terminal_at IS NOT NULL
      AND last_error_code IS NOT NULL)
  )
);
CREATE INDEX r3_analytics_event_deliveries_claim_idx
  ON r3_analytics_event_deliveries (available_at, source_event_id)
  WHERE state = 'PENDING';
CREATE INDEX r3_analytics_event_deliveries_reclaim_idx
  ON r3_analytics_event_deliveries (lease_expires_at, source_event_id)
  WHERE state = 'PROCESSING';

CREATE FUNCTION r3_analytics_traffic_class(candidate_user_id uuid)
RETURNS analytics_traffic_class LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN explicit.traffic_class = 'TEST' THEN 'TEST'::analytics_traffic_class
    WHEN explicit.traffic_class = 'INTERNAL' OR EXISTS (
      SELECT 1 FROM admin_role_grants grant_row
      WHERE grant_row.user_id = candidate_user_id
        AND grant_row.revoked_at IS NULL
        AND grant_row.role IN ('ADMIN', 'SUPER_ADMIN')
    ) THEN 'INTERNAL'::analytics_traffic_class
    ELSE 'REAL'::analytics_traffic_class END
  FROM (SELECT coalesce((
    SELECT current.traffic_class
    FROM current_user_analytics_traffic_classifications current
    WHERE current.user_id = candidate_user_id
  ), 'REAL'::analytics_traffic_class) AS traffic_class) explicit;
$$;

CREATE FUNCTION insert_exact_r3_analytics_source_event(
  candidate_key text,
  candidate_name text,
  candidate_occurred_at timestamptz,
  candidate_entity_type text,
  candidate_entity_id text,
  candidate_payload jsonb,
  candidate_command_name text,
  candidate_correlation_id text,
  candidate_event_id uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE existing domain_outbox_events%ROWTYPE;
DECLARE resolved_id uuid;
DECLARE inserted_id uuid;
BEGIN
  IF candidate_name NOT LIKE 'r3.analytics.%' THEN
    RAISE EXCEPTION 'R3 analytics source name is not owned';
  END IF;
  resolved_id := coalesce(candidate_event_id, gen_random_uuid());
  INSERT INTO domain_outbox_events (
    event_id, idempotency_key, event_name, schema_version, occurred_at,
    entity_type, entity_id, payload, command_name, correlation_id, available_at
  ) VALUES (
    resolved_id, candidate_key, candidate_name, 1, candidate_occurred_at,
    candidate_entity_type, candidate_entity_id, candidate_payload,
    candidate_command_name, candidate_correlation_id, candidate_occurred_at
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING event_id INTO inserted_id;
  SELECT * INTO existing FROM domain_outbox_events event
  WHERE event.idempotency_key = candidate_key FOR UPDATE;
  IF inserted_id IS NULL AND candidate_event_id IS NULL THEN
    resolved_id := existing.event_id;
  END IF;
  IF existing.event_id IS NULL
      OR existing.event_id IS DISTINCT FROM resolved_id
      OR existing.event_name IS DISTINCT FROM candidate_name
      OR existing.schema_version IS DISTINCT FROM 1
      OR existing.occurred_at IS DISTINCT FROM candidate_occurred_at
      OR existing.entity_type IS DISTINCT FROM candidate_entity_type
      OR existing.entity_id IS DISTINCT FROM candidate_entity_id
      OR existing.payload IS DISTINCT FROM candidate_payload
      OR existing.command_name IS DISTINCT FROM candidate_command_name
      OR existing.correlation_id IS DISTINCT FROM candidate_correlation_id THEN
    RAISE EXCEPTION 'R3 analytics outbox idempotency key collision';
  END IF;
  INSERT INTO r3_analytics_event_deliveries (
    source_event_id, available_at, created_at, updated_at
  ) VALUES (
    resolved_id, candidate_occurred_at, candidate_occurred_at,
    candidate_occurred_at
  ) ON CONFLICT (source_event_id) DO NOTHING;
  RETURN resolved_id;
END;
$$;

CREATE FUNCTION r3_analytics_subject_payload(
  candidate_user_id uuid,
  candidate_profile_context text,
  candidate_initiator r3_analytics_initiator,
  candidate_properties jsonb
)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'subject_user_id', candidate_user_id::text,
    'profile_context', candidate_profile_context,
    'traffic_class', r3_analytics_traffic_class(candidate_user_id)::text,
    'initiator', candidate_initiator::text
  ) || candidate_properties;
$$;

CREATE FUNCTION r3_analytics_profile_context(
  candidate_user_id uuid,
  preferred_context text
)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM customer_profiles customer
    WHERE customer.owner_user_id = candidate_user_id
  ) AND EXISTS (
    SELECT 1 FROM craftsman_profiles craftsman
    WHERE craftsman.owner_user_id = candidate_user_id
  ) THEN 'BOTH' ELSE preferred_context END;
$$;

CREATE FUNCTION capture_r3_job_request_state_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source job_request_commands%ROWTYPE;
DECLARE owner_id uuid;
DECLARE event_name text;
DECLARE event_key text;
DECLARE event_properties jsonb;
DECLARE core_payload jsonb;
DECLARE timing_payload jsonb;
DECLARE budget_payload jsonb;
DECLARE media_payload jsonb;
DECLARE photo_count integer;
DECLARE initiator r3_analytics_initiator;
BEGIN
  SELECT * INTO source FROM job_request_commands command
  WHERE command.command_id = NEW.command_id;
  SELECT customer.owner_user_id INTO owner_id
  FROM job_requests request
  JOIN customer_profiles customer ON customer.id = request.customer_profile_id
  WHERE request.id = NEW.job_request_id;
  IF owner_id IS NULL OR source.command_id IS NULL THEN
    RAISE EXCEPTION 'job request analytics provenance missing';
  END IF;
  initiator := CASE WHEN source.system_initiated THEN 'SYSTEM' ELSE 'USER' END;

  IF source.command_kind::text IN ('CREATE_DRAFT', 'CREATE_DRAFT_WITH_SECTION')
      AND NEW.revision = 1 THEN
    event_name := 'r3.analytics.job_request_started';
    event_key := 'r3-analytics:job-request:' || NEW.job_request_id::text
      || ':started';
    event_properties := jsonb_build_object(
      'job_request_id', NEW.job_request_id::text
    );
  ELSIF source.command_kind::text = 'ACTIVATE' AND NEW.state::text = 'ACTIVE' THEN
    SELECT section.payload INTO core_payload
    FROM current_job_request_active_sections section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.section_key = 'request.core';
    SELECT section.payload INTO timing_payload
    FROM current_job_request_active_sections section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.section_key = 'request.timing';
    SELECT section.payload INTO budget_payload
    FROM current_job_request_active_sections section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.section_key = 'request.budget';
    SELECT section.payload INTO media_payload
    FROM current_job_request_active_sections section
    WHERE section.job_request_id = NEW.job_request_id
      AND section.section_key = 'request.media';
    photo_count := coalesce(jsonb_array_length(
      coalesce(media_payload -> 'photoMediaAssetIds', '[]'::jsonb)
    ), 0);
    event_name := 'r3.analytics.job_request_submitted_v2';
    event_key := 'r3-analytics:job-request:' || NEW.job_request_id::text
      || ':submitted:' || NEW.revision::text;
    event_properties := jsonb_build_object(
      'job_request_id', NEW.job_request_id::text,
      'profession_code', core_payload ->> 'primaryProfessionCode',
      'photo_count_bucket', CASE WHEN photo_count = 0 THEN 'NONE'
        WHEN photo_count < 5 THEN 'ONE_TO_FOUR' ELSE 'FIVE_TO_TEN' END,
      'timing_option', coalesce(timing_payload ->> 'mode', 'NOT_PROVIDED'),
      'budget_provided', coalesce(budget_payload ->> 'mode', '')
        IN ('UP_TO', 'RANGE')
    );
  ELSIF source.command_kind::text = 'CANCEL' AND NEW.state::text = 'CANCELLED' THEN
    event_name := 'r3.analytics.job_request_cancelled';
    event_key := 'r3-analytics:job-request:' || NEW.job_request_id::text
      || ':cancelled:' || NEW.revision::text;
    event_properties := jsonb_build_object(
      'job_request_id', NEW.job_request_id::text,
      'cancellation_reason_category', NEW.cancellation_reason::text
    );
  ELSIF source.command_kind::text = 'EXPIRE' AND NEW.state::text = 'EXPIRED' THEN
    event_name := 'r3.analytics.job_request_expired';
    event_key := 'r3-analytics:job-request:' || NEW.job_request_id::text
      || ':expired:' || NEW.revision::text;
    event_properties := jsonb_build_object(
      'effect_initiator', 'SYSTEM',
      'job_request_id', NEW.job_request_id::text
    );
  ELSIF source.command_kind::text = 'REACTIVATE' AND NEW.state::text = 'ACTIVE' THEN
    event_name := 'r3.analytics.job_request_reactivated';
    event_key := 'r3-analytics:job-request:' || NEW.job_request_id::text
      || ':reactivated:' || NEW.revision::text;
    event_properties := jsonb_build_object('job_request_id', NEW.job_request_id::text);
  ELSE
    RETURN NEW;
  END IF;

  PERFORM insert_exact_r3_analytics_source_event(
    event_key, event_name, NEW.changed_at, 'JOB_REQUEST',
    NEW.job_request_id::text,
    r3_analytics_subject_payload(owner_id, 'CUSTOMER', initiator, event_properties),
    'job_request.' || lower(source.command_kind::text), NEW.command_id::text
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_job_request_state_analytics_capture
AFTER INSERT ON job_request_revisions
FOR EACH ROW EXECUTE FUNCTION capture_r3_job_request_state_analytics();

CREATE FUNCTION capture_r3_job_request_material_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
DECLARE material_count integer;
BEGIN
  IF NOT NEW.material_change OR NEW.command_id IS NULL THEN RETURN NEW; END IF;
  SELECT customer.owner_user_id INTO owner_id
  FROM job_requests request
  JOIN customer_profiles customer ON customer.id = request.customer_profile_id
  WHERE request.id = NEW.job_request_id;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'material analytics owner missing'; END IF;
  material_count := NEW.visible_version - 1;
  PERFORM insert_exact_r3_analytics_source_event(
    'r3-analytics:job-request:' || NEW.job_request_id::text || ':visible:'
      || NEW.visible_version::text,
    'r3.analytics.job_request_materially_revised', NEW.changed_at,
    'JOB_REQUEST', NEW.job_request_id::text,
    r3_analytics_subject_payload(owner_id, 'CUSTOMER', 'USER', jsonb_build_object(
      'job_request_id', NEW.job_request_id::text,
      'visible_version', NEW.visible_version,
      'material_revision_count_bucket', CASE WHEN material_count <= 1 THEN 'ONE'
        WHEN material_count = 2 THEN 'TWO' ELSE 'THREE_PLUS' END
    )), 'job_request.edit_active', NEW.command_id::text
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_job_request_material_analytics_capture
AFTER INSERT ON job_request_active_content_revisions
FOR EACH ROW EXECUTE FUNCTION capture_r3_job_request_material_analytics();

CREATE FUNCTION capture_r3_invitation_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source job_invitation_commands%ROWTYPE;
DECLARE request_id uuid;
DECLARE customer_owner_id uuid;
DECLARE provider_owner_id uuid;
DECLARE subject_id uuid;
DECLARE subject_context text;
DECLARE event_name text;
DECLARE event_key text;
DECLARE event_properties jsonb;
DECLARE initiator r3_analytics_initiator;
BEGIN
  SELECT * INTO source FROM job_invitation_commands command
  WHERE command.command_id = NEW.command_id;
  SELECT invitation.job_request_id, customer.owner_user_id,
      craftsman.owner_user_id
    INTO request_id, customer_owner_id, provider_owner_id
  FROM job_invitations invitation
  JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
  WHERE invitation.id = NEW.invitation_id;
  IF source.command_id IS NULL OR request_id IS NULL
      OR customer_owner_id IS NULL OR provider_owner_id IS NULL THEN
    RAISE EXCEPTION 'invitation analytics provenance missing';
  END IF;
  event_properties := jsonb_build_object(
    'invitation_id', NEW.invitation_id::text,
    'job_request_id', request_id::text
  );

  IF source.command_kind = 'SEND' THEN
    PERFORM insert_exact_r3_analytics_source_event(
      'r3-analytics:invitation:' || NEW.invitation_id::text || ':sent:customer',
      'r3.analytics.invitation_sent', NEW.changed_at, 'JOB_INVITATION',
      NEW.invitation_id::text,
      r3_analytics_subject_payload(customer_owner_id,
        r3_analytics_profile_context(customer_owner_id, 'CUSTOMER'),
        'USER', event_properties),
      'job_invitation.send', NEW.command_id::text
    );
    PERFORM insert_exact_r3_analytics_source_event(
      'r3-analytics:invitation:' || NEW.invitation_id::text || ':sent:provider',
      'r3.analytics.invitation_received', NEW.changed_at, 'JOB_INVITATION',
      NEW.invitation_id::text,
      r3_analytics_subject_payload(provider_owner_id,
        r3_analytics_profile_context(provider_owner_id, 'CRAFTSMAN'),
        'USER', event_properties),
      'job_invitation.send', NEW.command_id::text
    );
    RETURN NEW;
  ELSIF source.command_kind = 'ENGAGE' THEN
    event_name := 'r3.analytics.invitation_engaged';
    event_key := 'engaged';
    subject_id := provider_owner_id;
    subject_context := 'CRAFTSMAN';
  ELSIF source.command_kind = 'DECLINE' THEN
    event_name := 'r3.analytics.invitation_declined';
    event_key := 'declined';
    subject_id := provider_owner_id;
    subject_context := 'CRAFTSMAN';
    event_properties := event_properties || jsonb_build_object(
      'decline_reason_category', source.decline_reason::text
    );
  ELSIF source.command_kind = 'EXPIRE' THEN
    event_name := 'r3.analytics.invitation_expired';
    event_key := 'expired';
    subject_id := provider_owner_id;
    subject_context := 'CRAFTSMAN';
  ELSIF source.command_kind IN ('CUSTOMER_WITHDRAW', 'CRAFTSMAN_WITHDRAW', 'REQUEST_CLOSED') THEN
    event_name := 'r3.analytics.invitation_withdrawn';
    event_key := 'withdrawn:' || lower(source.command_kind::text);
    subject_id := CASE WHEN source.command_kind = 'CUSTOMER_WITHDRAW'
      THEN customer_owner_id ELSE provider_owner_id END;
    subject_context := CASE WHEN source.command_kind = 'CUSTOMER_WITHDRAW'
      THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END;
    event_properties := event_properties || jsonb_build_object(
      'withdrawal_source', CASE source.command_kind::text
        WHEN 'CUSTOMER_WITHDRAW' THEN 'CUSTOMER'
        WHEN 'CRAFTSMAN_WITHDRAW' THEN 'CRAFTSMAN'
        ELSE 'REQUEST_CLOSED' END
    );
  ELSIF source.command_kind IN ('CUSTOMER_STOP', 'NOT_SELECT') THEN
    event_name := 'r3.analytics.invitation_not_selected';
    event_key := 'not-selected:' || lower(source.command_kind::text);
    subject_id := provider_owner_id;
    subject_context := 'CRAFTSMAN';
  ELSE
    RETURN NEW;
  END IF;
  initiator := CASE WHEN source.system_initiated THEN 'SYSTEM' ELSE 'USER' END;
  IF event_name IN ('r3.analytics.invitation_expired',
      'r3.analytics.invitation_not_selected') THEN
    event_properties := event_properties || jsonb_build_object(
      'effect_initiator', initiator::text
    );
  END IF;
  PERFORM insert_exact_r3_analytics_source_event(
    'r3-analytics:invitation:' || NEW.invitation_id::text || ':' || event_key,
    event_name, NEW.changed_at, 'JOB_INVITATION', NEW.invitation_id::text,
    r3_analytics_subject_payload(subject_id,
      r3_analytics_profile_context(subject_id, subject_context),
      initiator, event_properties),
    'job_invitation.' || lower(source.command_kind::text), NEW.command_id::text
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_invitation_analytics_capture
AFTER INSERT ON job_invitation_revisions
FOR EACH ROW EXECUTE FUNCTION capture_r3_invitation_analytics();

CREATE FUNCTION capture_r3_conversation_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation_id uuid;
DECLARE customer_owner_id uuid;
DECLARE provider_owner_id uuid;
DECLARE author_context text;
DECLARE human_count integer;
DECLARE distinct_authors integer;
BEGIN
  IF NEW.entry_kind <> 'HUMAN_MESSAGE' THEN RETURN NEW; END IF;
  SELECT conversation.invitation_id, customer.owner_user_id,
      craftsman.owner_user_id
    INTO invitation_id, customer_owner_id, provider_owner_id
  FROM conversations conversation
  JOIN job_invitations invitation ON invitation.id = conversation.invitation_id
  JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
  WHERE conversation.id = NEW.conversation_id;
  IF invitation_id IS NULL OR NEW.author_user_id NOT IN (
      customer_owner_id, provider_owner_id) THEN
    RAISE EXCEPTION 'conversation analytics provenance missing';
  END IF;
  author_context := CASE WHEN NEW.author_user_id = customer_owner_id
    THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END;
  SELECT count(*), count(DISTINCT entry.author_user_id)
    INTO human_count, distinct_authors
  FROM conversation_timeline_entries entry
  WHERE entry.conversation_id = NEW.conversation_id
    AND entry.entry_kind = 'HUMAN_MESSAGE';

  IF human_count = 1 THEN
    PERFORM insert_exact_r3_analytics_source_event(
      'r3-analytics:conversation:' || NEW.conversation_id::text || ':first-message',
      'r3.analytics.conversation_first_message_sent', NEW.created_at,
      'CONVERSATION', NEW.conversation_id::text,
      r3_analytics_subject_payload(NEW.author_user_id,
        r3_analytics_profile_context(NEW.author_user_id, author_context),
        'USER', jsonb_build_object(
          'conversation_id', NEW.conversation_id::text,
          'invitation_id', invitation_id::text,
          'initiator_profile_context', author_context
        )), 'conversation.message', NEW.message_command_id::text
    );
  END IF;
  IF distinct_authors = 2 AND NOT EXISTS (
      SELECT 1 FROM domain_outbox_events event
      WHERE event.idempotency_key = 'r3-analytics:conversation:'
        || NEW.conversation_id::text || ':bilateral'
    ) THEN
    PERFORM insert_exact_r3_analytics_source_event(
      'r3-analytics:conversation:' || NEW.conversation_id::text || ':bilateral',
      'r3.analytics.conversation_bilateral_participation_reached', NEW.created_at,
      'CONVERSATION', NEW.conversation_id::text,
      r3_analytics_subject_payload(NEW.author_user_id,
        r3_analytics_profile_context(NEW.author_user_id, author_context),
        'USER', jsonb_build_object(
          'conversation_id', NEW.conversation_id::text,
          'invitation_id', invitation_id::text,
          'message_count_bucket', CASE WHEN human_count <= 4 THEN 'TWO_TO_FOUR'
            WHEN human_count <= 9 THEN 'FIVE_TO_NINE' ELSE 'TEN_PLUS' END
        )), 'conversation.message', NEW.message_command_id::text
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_conversation_analytics_capture
AFTER INSERT ON conversation_timeline_entries
FOR EACH ROW EXECUTE FUNCTION capture_r3_conversation_analytics();

CREATE FUNCTION capture_r3_conversation_attachment_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conversation_id uuid;
DECLARE attachment_count integer;
DECLARE type_count integer;
DECLARE attachment_type text;
DECLARE author_context text;
BEGIN
  IF NEW.status <> 'READY' OR NEW.provenance_entity_type <> 'CONVERSATION_MESSAGE'
      OR NEW.purpose NOT IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
      OR (TG_OP = 'UPDATE' AND OLD.status = 'READY') THEN RETURN NEW; END IF;
  SELECT message.conversation_id,
      CASE WHEN customer.owner_user_id = NEW.uploaded_by_user_id
        THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END
    INTO conversation_id, author_context
  FROM conversation_timeline_entries message
  JOIN conversations conversation ON conversation.id = message.conversation_id
  JOIN job_invitations invitation ON invitation.id = conversation.invitation_id
  JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
  JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
  WHERE message.id = NEW.provenance_entity_id
    AND message.author_user_id = NEW.uploaded_by_user_id
    AND NEW.uploaded_by_user_id IN (customer.owner_user_id, craftsman.owner_user_id)
    AND message.entry_kind = 'HUMAN_MESSAGE';
  IF conversation_id IS NULL THEN
    RAISE EXCEPTION 'attachment analytics provenance missing';
  END IF;
  SELECT count(*), count(DISTINCT asset.purpose)
    INTO attachment_count, type_count
  FROM media_assets asset
  WHERE asset.provenance_entity_type = 'CONVERSATION_MESSAGE'
    AND asset.provenance_entity_id = NEW.provenance_entity_id
    AND asset.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
    AND asset.status = 'READY';
  attachment_type := CASE WHEN type_count > 1 THEN 'MIXED'
    WHEN NEW.purpose = 'CHAT_IMAGE' THEN 'IMAGE' ELSE 'PDF' END;
  PERFORM insert_exact_r3_analytics_source_event(
    'r3-analytics:conversation-attachment:' || NEW.id::text || ':ready',
    'r3.analytics.conversation_attachment_ready', NEW.status_changed_at,
    'CONVERSATION_MESSAGE', NEW.provenance_entity_id::text,
    r3_analytics_subject_payload(NEW.uploaded_by_user_id,
      r3_analytics_profile_context(NEW.uploaded_by_user_id, author_context),
      'USER', jsonb_build_object(
        'attachment_count_bucket', CASE WHEN attachment_count = 1 THEN 'ONE'
          WHEN attachment_count <= 4 THEN 'TWO_TO_FOUR' ELSE 'FIVE_TO_TEN' END,
        'attachment_type_bucket', attachment_type,
        'conversation_id', conversation_id::text
      )), 'conversation.attachment.ready', NEW.id::text
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_conversation_attachment_analytics_capture
AFTER INSERT OR UPDATE OF status ON media_assets
FOR EACH ROW EXECUTE FUNCTION capture_r3_conversation_attachment_analytics();

CREATE FUNCTION r3_quote_analytics_context(
  candidate_quote_id uuid,
  OUT job_request_id uuid,
  OUT provider_owner_id uuid,
  OUT customer_owner_id uuid
) RETURNS record LANGUAGE sql STABLE AS $$
  SELECT invitation.job_request_id, craftsman.owner_user_id,
    customer.owner_user_id
  FROM quotes quote
  JOIN job_invitations invitation ON invitation.id = quote.invitation_id
  JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
  JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
  WHERE quote.id = candidate_quote_id;
$$;

CREATE FUNCTION capture_r3_quote_draft_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source quote_core_commands%ROWTYPE;
DECLARE context record;
DECLARE origin text;
BEGIN
  SELECT * INTO source FROM quote_core_commands command
  WHERE command.command_id = NEW.create_command_id;
  SELECT * INTO context FROM r3_quote_analytics_context(NEW.quote_id);
  IF source.command_id IS NULL OR context.job_request_id IS NULL THEN
    RAISE EXCEPTION 'quote draft analytics provenance missing';
  END IF;
  origin := CASE WHEN source.command_kind = 'CREATE_DRAFT' THEN 'INITIAL'
    WHEN source.source_state IN ('EXPIRED', 'WITHDRAWN') THEN 'RECONFIRM'
    ELSE 'REVISION' END;
  PERFORM insert_exact_r3_analytics_source_event(
    'r3-analytics:quote:' || NEW.quote_id::text || ':revision:'
      || NEW.revision::text || ':draft',
    'r3.analytics.quote_draft_created', NEW.created_at,
    'QUOTE_REVISION', NEW.quote_id::text || ':' || NEW.revision::text,
    r3_analytics_subject_payload(context.provider_owner_id,
      r3_analytics_profile_context(context.provider_owner_id, 'CRAFTSMAN'),
      'USER', jsonb_build_object(
        'authoring_mode', NEW.authoring_mode::text,
        'draft_origin', origin,
        'job_request_id', context.job_request_id::text,
        'quote_id', NEW.quote_id::text,
        'quote_revision', NEW.revision
      )), 'quote.' || lower(source.command_kind::text), source.command_id::text
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_quote_draft_analytics_capture
AFTER INSERT ON quote_revision_identities
FOR EACH ROW EXECUTE FUNCTION capture_r3_quote_draft_analytics();

CREATE FUNCTION capture_r3_quote_state_analytics()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity quote_revision_identities%ROWTYPE;
DECLARE context record;
DECLARE event_name text;
DECLARE event_key text;
DECLARE subject_id uuid;
DECLARE subject_context text;
DECLARE initiator r3_analytics_initiator := 'USER';
DECLARE correlation_type text;
DECLARE correlation_id text;
DECLARE price_mode text;
BEGIN
  IF NEW.state NOT IN ('SUBMITTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')
      THEN RETURN NEW; END IF;
  SELECT * INTO identity FROM quote_revision_identities quote_identity
  WHERE quote_identity.quote_id = NEW.quote_id
    AND quote_identity.revision = NEW.quote_revision;
  SELECT * INTO context FROM r3_quote_analytics_context(NEW.quote_id);
  IF identity.quote_id IS NULL OR context.job_request_id IS NULL THEN
    RAISE EXCEPTION 'quote state analytics provenance missing';
  END IF;
  IF identity.authoring_mode = 'PLATFORM_STRUCTURED' THEN
    SELECT content.price_mode::text INTO price_mode
    FROM current_quote_structured_content content
    WHERE content.quote_id = NEW.quote_id
      AND content.quote_revision = NEW.quote_revision;
  ELSE
    SELECT content.price_mode::text INTO price_mode
    FROM current_quote_external_pdf_content content
    WHERE content.quote_id = NEW.quote_id
      AND content.quote_revision = NEW.quote_revision
      AND content.provider_confirmed_summary_matches_pdf;
  END IF;

  IF NEW.state = 'SUBMITTED' THEN
    event_name := CASE WHEN NEW.quote_revision = 1
      THEN 'r3.analytics.quote_submitted_v2'
      ELSE 'r3.analytics.quote_revision_submitted' END;
    event_key := 'submitted'; subject_id := context.provider_owner_id;
    subject_context := 'CRAFTSMAN'; correlation_type := 'quote.submit';
    correlation_id := NEW.command_id::text;
  ELSIF NEW.state = 'REJECTED' THEN
    event_name := 'r3.analytics.quote_rejected'; event_key := 'rejected';
    subject_id := context.customer_owner_id; subject_context := 'CUSTOMER';
    correlation_type := 'quote.reject'; correlation_id := NEW.command_id::text;
  ELSIF NEW.state = 'WITHDRAWN' THEN
    event_name := 'r3.analytics.quote_withdrawn'; event_key := 'withdrawn';
    subject_id := context.provider_owner_id; subject_context := 'CRAFTSMAN';
    correlation_type := 'quote.withdraw';
    correlation_id := NEW.lifecycle_command_id::text;
  ELSE
    event_name := 'r3.analytics.quote_expired'; event_key := 'expired';
    subject_id := context.provider_owner_id; subject_context := 'CRAFTSMAN';
    initiator := 'SYSTEM'; correlation_type := 'quote.expire';
    correlation_id := NEW.lifecycle_command_id::text;
  END IF;
  PERFORM insert_exact_r3_analytics_source_event(
    'r3-analytics:quote:' || NEW.quote_id::text || ':revision:'
      || NEW.quote_revision::text || ':' || event_key,
    event_name, NEW.changed_at, 'QUOTE_REVISION',
    NEW.quote_id::text || ':' || NEW.quote_revision::text,
    r3_analytics_subject_payload(subject_id,
      r3_analytics_profile_context(subject_id, subject_context), initiator,
      jsonb_strip_nulls(jsonb_build_object(
        'authoring_mode', identity.authoring_mode::text,
        'effect_initiator', CASE WHEN NEW.state = 'EXPIRED'
          THEN initiator::text ELSE NULL END,
        'job_request_id', context.job_request_id::text,
        'price_mode', CASE WHEN NEW.state = 'SUBMITTED'
          THEN price_mode ELSE NULL END,
        'quote_id', NEW.quote_id::text,
        'quote_revision', NEW.quote_revision
      ))), correlation_type, correlation_id
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_r3_quote_state_analytics_capture
AFTER INSERT ON quote_revision_state_events
FOR EACH ROW EXECUTE FUNCTION capture_r3_quote_state_analytics();

CREATE TYPE r3_analytics_observation_kind AS ENUM (
  'INVITATION_VIEWED', 'QUOTE_VIEWED', 'QUOTE_COMPARISON_OPENED',
  'QUOTE_COMPARISON_PDF_OPENED'
);
CREATE TABLE r3_analytics_observation_commands (
  command_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  observation_kind r3_analytics_observation_kind NOT NULL,
  job_request_id uuid NOT NULL REFERENCES job_requests(id) ON DELETE RESTRICT,
  invitation_id uuid REFERENCES job_invitations(id) ON DELETE RESTRICT,
  quote_id uuid REFERENCES quotes(id) ON DELETE RESTRICT,
  quote_revision integer,
  available_quote_count integer,
  source_event_id uuid NOT NULL UNIQUE
    REFERENCES domain_outbox_events(event_id) DEFERRABLE INITIALLY DEFERRED,
  payload_fingerprint char(64) NOT NULL,
  observed_at timestamptz NOT NULL,
  CONSTRAINT r3_analytics_observation_quote_fk FOREIGN KEY (
    quote_id, quote_revision
  ) REFERENCES quote_revision_identities(quote_id, revision) ON DELETE RESTRICT,
  CONSTRAINT r3_analytics_observation_shape CHECK (
    (observation_kind = 'INVITATION_VIEWED' AND invitation_id IS NOT NULL
      AND quote_id IS NULL AND quote_revision IS NULL
      AND available_quote_count IS NULL)
    OR (observation_kind IN ('QUOTE_VIEWED', 'QUOTE_COMPARISON_PDF_OPENED')
      AND invitation_id IS NULL
      AND quote_id IS NOT NULL AND quote_revision IS NOT NULL
      AND available_quote_count IS NULL)
    OR (observation_kind = 'QUOTE_COMPARISON_OPENED'
      AND invitation_id IS NULL
      AND quote_id IS NULL AND quote_revision IS NULL
      AND available_quote_count BETWEEN 0 AND 5)
  ),
  CONSTRAINT r3_analytics_observation_fingerprint CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  )
);
CREATE UNIQUE INDEX r3_analytics_first_quote_view_idx
  ON r3_analytics_observation_commands (
    actor_user_id, observation_kind, quote_id, quote_revision
  ) WHERE observation_kind IN ('QUOTE_VIEWED', 'QUOTE_COMPARISON_PDF_OPENED');
CREATE UNIQUE INDEX r3_analytics_first_comparison_view_idx
  ON r3_analytics_observation_commands (
    actor_user_id, observation_kind, job_request_id
  ) WHERE observation_kind = 'QUOTE_COMPARISON_OPENED';
CREATE UNIQUE INDEX r3_analytics_first_invitation_view_idx
  ON r3_analytics_observation_commands (
    actor_user_id, observation_kind, invitation_id
  ) WHERE observation_kind = 'INVITATION_VIEWED';

CREATE FUNCTION validate_r3_analytics_observation_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer_profile_id uuid;
DECLARE invitation_id uuid;
DECLARE conversation_id uuid;
DECLARE quote_request_id uuid;
DECLARE authoring_mode quote_authoring_mode;
DECLARE current_state quote_revision_state;
DECLARE count_available integer;
BEGIN
  -- Same lock as optional-consent writes: withdrawal cannot race observation.
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.actor_user_id::text),
    hashtext('NON_ESSENTIAL_ANALYTICS')
  );
  PERFORM pg_advisory_xact_lock(41007, hashtext(NEW.job_request_id::text));
  PERFORM 1 FROM users actor WHERE actor.id = NEW.actor_user_id
    AND actor.account_state = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM privacy_consent_events consent
      WHERE consent.subject_user_id = NEW.actor_user_id
        AND consent.purpose = 'NON_ESSENTIAL_ANALYTICS'
      ORDER BY consent.revision DESC LIMIT 1
    ) OR (SELECT consent.action FROM privacy_consent_events consent
      WHERE consent.subject_user_id = NEW.actor_user_id
        AND consent.purpose = 'NON_ESSENTIAL_ANALYTICS'
      ORDER BY consent.revision DESC LIMIT 1) <> 'GRANTED' THEN
    RAISE EXCEPTION 'analytics observation unavailable';
  END IF;
  IF NEW.observation_kind = 'INVITATION_VIEWED' THEN
    PERFORM 1 FROM job_invitations invitation
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    JOIN job_requests request ON request.id = invitation.job_request_id
    WHERE invitation.id = NEW.invitation_id
      AND invitation.job_request_id = NEW.job_request_id
      AND craftsman.owner_user_id = NEW.actor_user_id
    FOR UPDATE OF invitation, craftsman, request;
    IF NOT FOUND THEN RAISE EXCEPTION 'analytics observation unavailable'; END IF;
    NEW.quote_id := NULL; NEW.quote_revision := NULL;
    NEW.available_quote_count := NULL;
  ELSE
    SELECT customer.id INTO customer_profile_id
    FROM customer_profiles customer
    JOIN job_requests request ON request.customer_profile_id = customer.id
    WHERE request.id = NEW.job_request_id
      AND customer.owner_user_id = NEW.actor_user_id
    FOR UPDATE OF customer, request;
    IF customer_profile_id IS NULL THEN
      RAISE EXCEPTION 'analytics observation unavailable';
    END IF;
  END IF;

  IF NEW.observation_kind = 'INVITATION_VIEWED' THEN
    NULL;
  ELSIF NEW.observation_kind = 'QUOTE_COMPARISON_OPENED' THEN
    SELECT LEAST(count(*), 5)::integer INTO count_available
    FROM current_submitted_quotes submitted
    JOIN quotes quote ON quote.id = submitted.quote_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    WHERE invitation.job_request_id = NEW.job_request_id
      AND quote_revision_authoring_is_eligible(
        submitted.quote_id, submitted.revision, submitted.authoring_mode)
      AND (quote_revision_valid_until(submitted.quote_id, submitted.revision,
          submitted.authoring_mode) IS NULL
        OR quote_revision_valid_until(submitted.quote_id, submitted.revision,
          submitted.authoring_mode) > clock_timestamp());
    NEW.quote_id := NULL; NEW.quote_revision := NULL;
    NEW.available_quote_count := count_available;
  ELSE
    SELECT invitation.id, conversation.id, invitation.job_request_id,
        identity.authoring_mode, state.state
      INTO invitation_id, conversation_id, quote_request_id,
        authoring_mode, current_state
    FROM quotes quote
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN conversations conversation ON conversation.id = quote.conversation_id
    JOIN quote_revision_identities identity ON identity.quote_id = quote.id
      AND identity.revision = NEW.quote_revision
    JOIN current_quote_revision_states state ON state.quote_id = identity.quote_id
      AND state.revision = identity.revision
    WHERE quote.id = NEW.quote_id
    FOR UPDATE OF invitation, conversation, quote;
    PERFORM 1 FROM quote_revision_heads head
    WHERE head.quote_id = NEW.quote_id AND head.quote_revision = NEW.quote_revision
    FOR UPDATE;
    IF invitation_id IS NULL OR quote_request_id <> NEW.job_request_id
        OR current_state <> 'SUBMITTED'
        OR NOT quote_revision_authoring_is_eligible(
          NEW.quote_id, NEW.quote_revision, authoring_mode)
        OR (quote_revision_valid_until(NEW.quote_id, NEW.quote_revision,
          authoring_mode) IS NOT NULL
          AND quote_revision_valid_until(NEW.quote_id, NEW.quote_revision,
            authoring_mode) <= clock_timestamp()) THEN
      RAISE EXCEPTION 'analytics observation unavailable';
    END IF;
    IF NEW.observation_kind = 'QUOTE_COMPARISON_PDF_OPENED'
        AND authoring_mode <> 'EXTERNAL_PDF' THEN
      RAISE EXCEPTION 'analytics observation unavailable';
    END IF;
    NEW.available_quote_count := NULL;
  END IF;
  NEW.source_event_id := gen_random_uuid();
  NEW.observed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_r3_analytics_observation_command_guard
BEFORE INSERT ON r3_analytics_observation_commands
FOR EACH ROW EXECUTE FUNCTION validate_r3_analytics_observation_command();

CREATE FUNCTION capture_r3_analytics_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_name text;
DECLARE properties jsonb;
BEGIN
  event_name := CASE NEW.observation_kind
    WHEN 'INVITATION_VIEWED' THEN 'r3.analytics.invitation_viewed'
    WHEN 'QUOTE_VIEWED' THEN 'r3.analytics.quote_viewed'
    WHEN 'QUOTE_COMPARISON_OPENED' THEN 'r3.analytics.quote_comparison_opened'
    ELSE 'r3.analytics.quote_comparison_pdf_opened' END;
  properties := CASE WHEN NEW.observation_kind = 'INVITATION_VIEWED'
    THEN jsonb_build_object(
      'invitation_id', NEW.invitation_id::text,
      'job_request_id', NEW.job_request_id::text)
    WHEN NEW.observation_kind = 'QUOTE_COMPARISON_OPENED'
    THEN jsonb_build_object(
      'available_quote_count', NEW.available_quote_count,
      'job_request_id', NEW.job_request_id::text)
    ELSE jsonb_build_object(
      'authoring_mode', (SELECT identity.authoring_mode::text
        FROM quote_revision_identities identity
        WHERE identity.quote_id = NEW.quote_id
          AND identity.revision = NEW.quote_revision),
      'job_request_id', NEW.job_request_id::text,
      'quote_id', NEW.quote_id::text,
      'quote_revision', NEW.quote_revision) END;
  PERFORM insert_exact_r3_analytics_source_event(
    'r3-analytics:observation:' || NEW.command_id::text,
    event_name, NEW.observed_at, 'ANALYTICS_OBSERVATION', NEW.command_id::text,
    r3_analytics_subject_payload(NEW.actor_user_id,
      r3_analytics_profile_context(NEW.actor_user_id,
        CASE WHEN NEW.observation_kind = 'INVITATION_VIEWED'
          THEN 'CRAFTSMAN' ELSE 'CUSTOMER' END),
      'USER', properties), 'analytics.observation', NEW.command_id::text,
    NEW.source_event_id
  );
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER z_r3_analytics_observation_capture
AFTER INSERT ON r3_analytics_observation_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION capture_r3_analytics_observation();

CREATE FUNCTION reject_r3_analytics_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'R3 analytics history is append-only'; END;
$$;
CREATE TRIGGER r3_analytics_observation_commands_append_only
BEFORE UPDATE OR DELETE ON r3_analytics_observation_commands
FOR EACH ROW EXECUTE FUNCTION reject_r3_analytics_mutation();

COMMENT ON TABLE r3_analytics_event_deliveries IS
  'Independent analytics-consumer lease state; never competes for or mutates the global domain outbox status.';
COMMENT ON TABLE r3_analytics_observation_commands IS
  'Consent-gated, exact participant-authorized first visible UX observations. No raw commercial content, PDF identifiers, storage metadata, contact data or competitor lists.';
