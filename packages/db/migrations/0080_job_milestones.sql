-- D18 execution milestones are private operational records, never commercial amendments.
CREATE TYPE job_milestone_state AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'SKIPPED');
CREATE TYPE job_milestone_event_kind AS ENUM ('CREATE', 'EDIT', 'STATE', 'REORDER', 'ASSIGN');

CREATE TABLE job_milestones (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, id)
);

CREATE TABLE job_milestone_events (
  event_id uuid PRIMARY KEY,
  milestone_id uuid NOT NULL REFERENCES job_milestones(id) ON DELETE RESTRICT,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  kind job_milestone_event_kind NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  title text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 160 AND title !~ '[[:cntrl:]]'),
  description text CHECK (description IS NULL OR (description = btrim(description) AND length(description) BETWEEN 1 AND 2000 AND description !~ '[[:cntrl:]]')),
  planned_start_date date,
  planned_end_date date,
  state job_milestone_state NOT NULL,
  order_key numeric(40,20) NOT NULL CHECK (order_key::text <> 'NaN'),
  responsible_participant_id uuid REFERENCES job_participants(id) ON DELETE RESTRICT,
  responsible_work_group_id uuid REFERENCES job_work_groups(id) ON DELETE RESTRICT,
  accepted_stage_label text CHECK (accepted_stage_label IS NULL OR (accepted_stage_label = btrim(accepted_stage_label) AND length(accepted_stage_label) BETWEEN 1 AND 160 AND accepted_stage_label !~ '[[:cntrl:]]')),
  accepted_quote_id uuid,
  accepted_quote_revision integer,
  accepted_pdf_media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (milestone_id, event_sequence),
  CONSTRAINT milestone_date_order CHECK (planned_start_date IS NULL OR planned_end_date IS NULL OR planned_start_date <= planned_end_date),
  CONSTRAINT milestone_one_responsibility CHECK (responsible_participant_id IS NULL OR responsible_work_group_id IS NULL),
  CONSTRAINT milestone_accepted_source_pair CHECK ((accepted_stage_label IS NULL) = (accepted_quote_id IS NULL) AND (accepted_stage_label IS NULL) = (accepted_quote_revision IS NULL))
);
CREATE INDEX job_milestone_events_latest_idx ON job_milestone_events (milestone_id, event_sequence DESC);
CREATE INDEX job_milestones_job_idx ON job_milestones (job_id, created_at, id);

CREATE VIEW current_job_milestones AS
SELECT milestone.id, milestone.job_id, milestone.created_by_user_id, milestone.created_at,
  latest.event_id, latest.event_sequence, latest.title, latest.description,
  latest.planned_start_date, latest.planned_end_date, latest.state,
  latest.order_key, latest.responsible_participant_id,
  latest.responsible_work_group_id, latest.accepted_stage_label,
  latest.accepted_quote_id, latest.accepted_quote_revision,
  latest.accepted_pdf_media_asset_id, latest.recorded_at AS updated_at
FROM job_milestones milestone
JOIN LATERAL (
  SELECT * FROM job_milestone_events event
  WHERE event.milestone_id = milestone.id
  ORDER BY event.event_sequence DESC LIMIT 1
) latest ON true;

CREATE FUNCTION job_milestone_actor_role(target_job_id uuid, target_actor_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN customer.owner_user_id = actor.id THEN 'CUSTOMER'
    WHEN provider.owner_user_id = actor.id THEN 'PRIMARY_PROVIDER'
    WHEN EXISTS (
      SELECT 1 FROM current_job_participants participant
      JOIN craftsman_profiles profile ON profile.id = participant.craftsman_profile_id
      WHERE participant.job_id = job.id AND participant.state = 'ACCEPTED'
        AND profile.owner_user_id = actor.id
    ) THEN 'PARTICIPANT'
    ELSE NULL END
  FROM jobs job
  JOIN customer_profiles customer ON customer.id = job.customer_profile_id
  JOIN craftsman_profiles provider ON provider.id = job.primary_craftsman_profile_id
  JOIN job_acceptance_events accepted ON accepted.job_id = job.id
  JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
  JOIN users actor ON actor.id = target_actor_id AND actor.account_state = 'ACTIVE'
  JOIN auth_credentials credentials ON credentials.user_id = actor.id
    AND credentials.email_verified_at IS NOT NULL
    AND credentials.phone_verified_at IS NOT NULL
  WHERE job.id = target_job_id;
$$;

CREATE FUNCTION job_milestone_can_plan(target_job_id uuid, target_actor_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(job_milestone_actor_role(target_job_id, target_actor_id) = 'PRIMARY_PROVIDER'
    OR (job_milestone_actor_role(target_job_id, target_actor_id) = 'PARTICIPANT' AND EXISTS (
      SELECT 1 FROM current_job_participants participant
      JOIN craftsman_profiles profile ON profile.id = participant.craftsman_profile_id
      JOIN job_participant_role_intervals role ON role.participant_id = participant.id
      WHERE participant.job_id = target_job_id AND participant.state = 'ACCEPTED'
        AND profile.owner_user_id = target_actor_id AND role.active
        AND role.role IN ('LEAD', 'COORDINATOR', 'SITE_MANAGER')
    )), false);
$$;

CREATE FUNCTION validate_job_milestone_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state job_state;
BEGIN
  PERFORM 1 FROM jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirmed Job required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51011));
  PERFORM 1 FROM users WHERE id = NEW.created_by_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials
    WHERE user_id = NEW.created_by_user_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = NEW.job_id;
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR NOT job_milestone_can_plan(NEW.job_id, NEW.created_by_user_id) THEN
    RAISE EXCEPTION 'active Job planner required';
  END IF;
  IF EXISTS (SELECT 1 FROM job_milestone_events WHERE event_id = NEW.id)
    OR EXISTS (SELECT 1 FROM job_milestone_acknowledgements WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'milestone command ID collision';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION require_job_milestone_create_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_milestone_events event
    WHERE event.milestone_id = NEW.id AND event.event_sequence = 1
      AND event.kind = 'CREATE' AND event.event_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Job milestone identity requires CREATE event';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_job_milestone_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  current_state job_state;
  previous job_milestone_events%ROWTYPE;
  source_job jobs%ROWTYPE;
  source_snapshot job_agreement_snapshots%ROWTYPE;
BEGIN
  SELECT job_id INTO target_job_id FROM job_milestones WHERE id = NEW.milestone_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'milestone required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.event_id::text, 51011));
  PERFORM 1 FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials
    WHERE user_id = NEW.actor_user_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = target_job_id;
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR NOT job_milestone_can_plan(target_job_id, NEW.actor_user_id) THEN
    RAISE EXCEPTION 'active Job planner required';
  END IF;
  IF NEW.state IN ('DONE', 'SKIPPED') AND NEW.kind = 'STATE'
    AND job_milestone_actor_role(target_job_id, NEW.actor_user_id) <> 'PRIMARY_PROVIDER' THEN
    RAISE EXCEPTION 'primary provider required for completed milestone';
  END IF;
  IF NEW.intent->>'kind' IS DISTINCT FROM NEW.kind::text THEN
    RAISE EXCEPTION 'milestone intent kind mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM job_milestones
      WHERE id = NEW.event_id AND (NEW.kind <> 'CREATE' OR id <> NEW.milestone_id))
    OR EXISTS (SELECT 1 FROM job_milestone_acknowledgements WHERE id = NEW.event_id) THEN
    RAISE EXCEPTION 'milestone command ID collision';
  END IF;
  IF NEW.responsible_participant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM current_job_participants participant
    WHERE participant.id = NEW.responsible_participant_id
      AND participant.job_id = target_job_id AND participant.state = 'ACCEPTED'
  ) THEN RAISE EXCEPTION 'active exact-Job participant required'; END IF;
  IF NEW.responsible_work_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM job_work_groups group_row
    WHERE group_row.id = NEW.responsible_work_group_id AND group_row.job_id = target_job_id
  ) THEN RAISE EXCEPTION 'exact-Job work group required'; END IF;
  SELECT * INTO previous FROM job_milestone_events
    WHERE milestone_id = NEW.milestone_id ORDER BY event_sequence DESC LIMIT 1;
  IF previous.event_id IS NULL THEN
    IF NEW.kind <> 'CREATE' OR NEW.event_sequence <> 1 OR NEW.state <> 'PLANNED'
      OR NEW.actor_user_id <> (SELECT created_by_user_id FROM job_milestones WHERE id = NEW.milestone_id)
      OR NEW.event_id <> NEW.milestone_id THEN
      RAISE EXCEPTION 'first milestone event must be CREATE';
    END IF;
    IF NEW.accepted_stage_label IS NOT NULL THEN
      IF job_milestone_actor_role(target_job_id, NEW.actor_user_id)
        IS DISTINCT FROM 'PRIMARY_PROVIDER' THEN
        RAISE EXCEPTION 'primary provider required for accepted stage mapping';
      END IF;
      SELECT * INTO source_job FROM jobs WHERE id = target_job_id;
      SELECT * INTO source_snapshot FROM job_agreement_snapshots WHERE job_id = target_job_id;
      IF NEW.accepted_quote_id IS DISTINCT FROM source_job.accepted_quote_id
        OR NEW.accepted_quote_revision IS DISTINCT FROM source_job.accepted_quote_revision
        OR NEW.accepted_pdf_media_asset_id IS DISTINCT FROM source_snapshot.pdf_media_asset_id THEN
        RAISE EXCEPTION 'accepted stage source must be pinned Job agreement';
      END IF;
    ELSIF NEW.accepted_quote_id IS NOT NULL OR NEW.accepted_quote_revision IS NOT NULL
      OR NEW.accepted_pdf_media_asset_id IS NOT NULL THEN
      RAISE EXCEPTION 'accepted stage provenance requires label';
    END IF;
  ELSE
    IF NEW.event_sequence <> previous.event_sequence + 1 OR NEW.kind = 'CREATE'
      OR NEW.accepted_stage_label IS DISTINCT FROM previous.accepted_stage_label
      OR NEW.accepted_quote_id IS DISTINCT FROM previous.accepted_quote_id
      OR NEW.accepted_quote_revision IS DISTINCT FROM previous.accepted_quote_revision
      OR NEW.accepted_pdf_media_asset_id IS DISTINCT FROM previous.accepted_pdf_media_asset_id THEN
      RAISE EXCEPTION 'invalid milestone event sequence or provenance';
    END IF;
    IF NEW.kind <> 'EDIT' AND (NEW.title IS DISTINCT FROM previous.title
      OR NEW.description IS DISTINCT FROM previous.description
      OR NEW.planned_start_date IS DISTINCT FROM previous.planned_start_date
      OR NEW.planned_end_date IS DISTINCT FROM previous.planned_end_date) THEN
      RAISE EXCEPTION 'milestone text/date change requires EDIT';
    END IF;
    IF NEW.kind <> 'STATE' AND NEW.state IS DISTINCT FROM previous.state THEN
      RAISE EXCEPTION 'milestone state change requires STATE';
    END IF;
    IF NEW.kind <> 'REORDER' AND NEW.order_key IS DISTINCT FROM previous.order_key THEN
      RAISE EXCEPTION 'milestone ordering change requires REORDER';
    END IF;
    IF NEW.kind <> 'ASSIGN' AND (NEW.responsible_participant_id IS DISTINCT FROM previous.responsible_participant_id
      OR NEW.responsible_work_group_id IS DISTINCT FROM previous.responsible_work_group_id) THEN
      RAISE EXCEPTION 'milestone responsibility change requires ASSIGN';
    END IF;
    IF previous.state IN ('DONE', 'SKIPPED') AND NEW.kind = 'STATE'
      AND NEW.state <> previous.state THEN
      RAISE EXCEPTION 'terminal milestone state is immutable';
    END IF;
    IF NEW.kind = 'STATE' AND NOT (
      (previous.state = 'PLANNED' AND NEW.state IN ('IN_PROGRESS', 'DONE', 'SKIPPED'))
      OR (previous.state = 'IN_PROGRESS' AND NEW.state IN ('DONE', 'SKIPPED', 'PLANNED'))
    ) THEN RAISE EXCEPTION 'invalid milestone state transition'; END IF;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE job_milestone_acknowledgements (
  id uuid PRIMARY KEY,
  milestone_id uuid NOT NULL REFERENCES job_milestones(id) ON DELETE RESTRICT,
  customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (milestone_id, customer_user_id)
);

CREATE FUNCTION validate_job_milestone_acknowledgement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; current_state job_state;
BEGIN
  SELECT job_id INTO target_job_id FROM job_milestones WHERE id = NEW.milestone_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'milestone required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51011));
  PERFORM 1 FROM users WHERE id = NEW.customer_user_id FOR SHARE;
  PERFORM 1 FROM auth_credentials
    WHERE user_id = NEW.customer_user_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = target_job_id;
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS')
    OR job_milestone_actor_role(target_job_id, NEW.customer_user_id) IS DISTINCT FROM 'CUSTOMER' THEN
    RAISE EXCEPTION 'active Job customer required';
  END IF;
  IF EXISTS (SELECT 1 FROM job_milestones WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM job_milestone_events WHERE event_id = NEW.id) THEN
    RAISE EXCEPTION 'milestone command ID collision';
  END IF;
  NEW.acknowledged_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_job_milestone_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job milestone history is immutable'; END;
$$;

CREATE TRIGGER milestone_identity_validate BEFORE INSERT ON job_milestones
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_identity();
CREATE CONSTRAINT TRIGGER milestone_identity_requires_event
  AFTER INSERT ON job_milestones DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_job_milestone_create_event();
CREATE TRIGGER milestone_event_validate BEFORE INSERT ON job_milestone_events
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_event();
CREATE TRIGGER milestone_ack_validate BEFORE INSERT ON job_milestone_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_acknowledgement();
CREATE TRIGGER milestone_identity_immutable BEFORE UPDATE OR DELETE ON job_milestones
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();
CREATE TRIGGER milestone_event_immutable BEFORE UPDATE OR DELETE ON job_milestone_events
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();
CREATE TRIGGER milestone_ack_immutable BEFORE UPDATE OR DELETE ON job_milestone_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();

COMMENT ON TABLE job_milestone_events IS 'Append-only operational projection; never a commercial agreement or payment record.';
COMMENT ON TABLE job_milestone_acknowledgements IS 'Informational customer acknowledgement, never handover or commercial approval.';
