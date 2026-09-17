-- Customer proposals and discussion remain separate from authoritative
-- execution planning. Media links refer only to existing central Job documents.
CREATE TYPE job_milestone_proposal_decision AS ENUM ('ACCEPT', 'DECLINE');

ALTER TABLE job_milestone_events
  ADD COLUMN creation_txid bigint NOT NULL DEFAULT txid_current();

CREATE TABLE job_milestone_proposals (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  target_milestone_id uuid REFERENCES job_milestones(id) ON DELETE RESTRICT,
  baseline_event_id uuid REFERENCES job_milestone_events(event_id) ON DELETE RESTRICT,
  customer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 160
    AND title !~ '[[:cntrl:]]'),
  description text CHECK (description IS NULL OR (description = btrim(description)
    AND length(description) BETWEEN 1 AND 2000 AND description !~ '[[:cntrl:]]')),
  planned_start_date date,
  planned_end_date date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT proposal_baseline_pair CHECK ((target_milestone_id IS NULL) = (baseline_event_id IS NULL)),
  CONSTRAINT proposal_date_order CHECK (planned_start_date IS NULL OR planned_end_date IS NULL
    OR planned_start_date <= planned_end_date)
);
CREATE INDEX job_milestone_proposals_job_idx ON job_milestone_proposals (job_id, created_at DESC, id DESC);
CREATE INDEX job_milestone_proposals_target_idx ON job_milestone_proposals (target_milestone_id)
  WHERE target_milestone_id IS NOT NULL;

CREATE TABLE job_milestone_proposal_decisions (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL UNIQUE REFERENCES job_milestone_proposals(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision job_milestone_proposal_decision NOT NULL,
  applied_event_id uuid UNIQUE REFERENCES job_milestone_events(event_id) ON DELETE RESTRICT,
  creation_txid bigint NOT NULL DEFAULT txid_current(),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT proposal_decision_event_pair CHECK ((decision = 'ACCEPT') = (applied_event_id IS NOT NULL))
);

CREATE TABLE job_milestone_comments (
  id uuid PRIMARY KEY,
  milestone_id uuid NOT NULL REFERENCES job_milestones(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role text NOT NULL CHECK (author_role IN ('CUSTOMER', 'PRIMARY_PROVIDER', 'PARTICIPANT')),
  body text NOT NULL CHECK (body = btrim(body) AND length(body) BETWEEN 1 AND 2000
    AND body !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX job_milestone_comments_page_idx ON job_milestone_comments (milestone_id, created_at DESC, id DESC);

CREATE TABLE job_milestone_media (
  id uuid PRIMARY KEY,
  milestone_id uuid NOT NULL REFERENCES job_milestones(id) ON DELETE RESTRICT,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  linked_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (milestone_id, media_asset_id)
);
CREATE INDEX job_milestone_media_page_idx ON job_milestone_media (milestone_id, linked_at DESC, id DESC);

CREATE FUNCTION validate_job_milestone_context_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  target_actor_id uuid;
  actor_role text;
  current_state job_state;
  proposal job_milestone_proposals%ROWTYPE;
  applied job_milestone_events%ROWTYPE;
  current_event_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'job_milestone_proposals' THEN
    target_job_id := NEW.job_id;
    target_actor_id := NEW.customer_user_id;
  ELSIF TG_TABLE_NAME = 'job_milestone_proposal_decisions' THEN
    SELECT * INTO proposal FROM job_milestone_proposals WHERE id = NEW.proposal_id;
    target_job_id := proposal.job_id;
    target_actor_id := NEW.actor_user_id;
  ELSE
    SELECT job_id INTO target_job_id FROM job_milestones
      WHERE id = NEW.milestone_id;
    IF TG_TABLE_NAME = 'job_milestone_comments' THEN
      target_actor_id := NEW.author_user_id;
    ELSE
      target_actor_id := NEW.linked_by_user_id;
    END IF;
  END IF;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'exact Job milestone or proposal required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 51011));
  PERFORM 1 FROM users WHERE id = target_actor_id FOR SHARE;
  PERFORM 1 FROM auth_credentials WHERE user_id = target_actor_id FOR SHARE;
  SELECT state INTO current_state FROM current_job_states WHERE job_id = target_job_id;
  IF current_state IS NULL OR current_state NOT IN ('CONFIRMED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'active Job required for milestone context';
  END IF;
  actor_role := job_milestone_actor_role(target_job_id, target_actor_id);
  IF actor_role IS NULL THEN RAISE EXCEPTION 'authorized exact-Job actor required'; END IF;
  IF EXISTS (SELECT 1 FROM job_milestone_events WHERE event_id = NEW.id)
    OR EXISTS (SELECT 1 FROM job_milestone_acknowledgements WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM job_milestones WHERE id = NEW.id)
    OR (TG_TABLE_NAME <> 'job_milestone_proposals' AND EXISTS
      (SELECT 1 FROM job_milestone_proposals WHERE id = NEW.id))
    OR (TG_TABLE_NAME <> 'job_milestone_proposal_decisions' AND EXISTS
      (SELECT 1 FROM job_milestone_proposal_decisions WHERE id = NEW.id))
    OR (TG_TABLE_NAME <> 'job_milestone_comments' AND EXISTS
      (SELECT 1 FROM job_milestone_comments WHERE id = NEW.id))
    OR (TG_TABLE_NAME <> 'job_milestone_media' AND EXISTS
      (SELECT 1 FROM job_milestone_media WHERE id = NEW.id)) THEN
    RAISE EXCEPTION 'milestone context command ID collision';
  END IF;
  IF TG_TABLE_NAME = 'job_milestone_proposals' THEN
    IF actor_role <> 'CUSTOMER' THEN RAISE EXCEPTION 'Job customer required for proposal'; END IF;
    IF NEW.target_milestone_id IS NOT NULL THEN
      SELECT event_id INTO current_event_id FROM current_job_milestones
        WHERE id = NEW.target_milestone_id AND job_id = target_job_id;
      IF current_event_id IS NULL OR NEW.baseline_event_id IS DISTINCT FROM current_event_id THEN
        RAISE EXCEPTION 'exact current milestone baseline required';
      END IF;
    END IF;
    NEW.created_at := clock_timestamp();
  ELSIF TG_TABLE_NAME = 'job_milestone_proposal_decisions' THEN
    IF NOT job_milestone_can_plan(target_job_id, target_actor_id) THEN
      RAISE EXCEPTION 'active milestone planner required for proposal decision';
    END IF;
    IF NEW.decision = 'ACCEPT' THEN
      SELECT * INTO applied FROM job_milestone_events WHERE event_id = NEW.applied_event_id;
      IF applied.event_id IS NULL OR applied.creation_txid IS DISTINCT FROM txid_current()
        OR NOT EXISTS (SELECT 1 FROM current_job_milestones current
          WHERE current.id = applied.milestone_id AND current.job_id = target_job_id
            AND current.event_id = applied.event_id)
        OR applied.actor_user_id IS DISTINCT FROM target_actor_id
        OR applied.title IS DISTINCT FROM proposal.title
        OR applied.description IS DISTINCT FROM proposal.description
        OR applied.planned_start_date IS DISTINCT FROM proposal.planned_start_date
        OR applied.planned_end_date IS DISTINCT FROM proposal.planned_end_date THEN
        RAISE EXCEPTION 'proposal acceptance requires same-transaction matching plan event';
      END IF;
      IF proposal.target_milestone_id IS NULL THEN
        IF applied.kind <> 'CREATE' OR applied.milestone_id <> applied.event_id
          OR NOT EXISTS (SELECT 1 FROM job_milestones milestone
            WHERE milestone.id = applied.milestone_id AND milestone.job_id = target_job_id)
          OR applied.accepted_stage_label IS NOT NULL THEN
          RAISE EXCEPTION 'proposal must create non-commercial exact-Job milestone';
        END IF;
      ELSE
        IF applied.kind <> 'EDIT' OR applied.milestone_id <> proposal.target_milestone_id
          OR NOT EXISTS (SELECT 1 FROM job_milestone_events prior
            WHERE prior.event_id = proposal.baseline_event_id
              AND prior.milestone_id = proposal.target_milestone_id
              AND prior.event_sequence + 1 = applied.event_sequence) THEN
          RAISE EXCEPTION 'proposal baseline changed before acceptance';
        END IF;
      END IF;
    ELSE
      IF NEW.applied_event_id IS NOT NULL THEN RAISE EXCEPTION 'decline cannot change plan'; END IF;
    END IF;
    NEW.creation_txid := txid_current();
    NEW.decided_at := clock_timestamp();
  ELSIF TG_TABLE_NAME = 'job_milestone_comments' THEN
    NEW.author_role := actor_role;
    NEW.created_at := clock_timestamp();
  ELSE
    IF actor_role NOT IN ('CUSTOMER', 'PRIMARY_PROVIDER') THEN
      RAISE EXCEPTION 'central Job documentation access required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM job_conversation_media media
      JOIN media_assets asset ON asset.id = media.media_asset_id
        AND asset.status = 'READY'
        AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
      JOIN media_asset_storage_objects canonical ON canonical.media_asset_id = asset.id
        AND canonical.role = 'CANONICAL' AND canonical.storage_area = 'private'
        AND canonical.revoked_at IS NULL
      WHERE media.job_id = target_job_id AND media.media_asset_id = NEW.media_asset_id
        AND ((media.media_kind = 'IMAGE' AND asset.kind = 'IMAGE')
          OR (media.media_kind = 'DOCUMENT' AND asset.kind = 'DOCUMENT'
            AND canonical.content_type = 'application/pdf'))
    ) THEN RAISE EXCEPTION 'same-Job READY private document required'; END IF;
    NEW.linked_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_job_milestone_addon_id_collision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'job_milestone_events' THEN command_id := NEW.event_id;
  ELSE command_id := NEW.id; END IF;
  IF EXISTS (SELECT 1 FROM job_milestone_proposals WHERE id = command_id)
    OR EXISTS (SELECT 1 FROM job_milestone_proposal_decisions WHERE id = command_id)
    OR EXISTS (SELECT 1 FROM job_milestone_comments WHERE id = command_id)
    OR EXISTS (SELECT 1 FROM job_milestone_media WHERE id = command_id) THEN
    RAISE EXCEPTION 'milestone command ID collision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_milestone_identity_addon_collision BEFORE INSERT ON job_milestones
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_addon_id_collision();
CREATE TRIGGER zz_milestone_event_addon_collision BEFORE INSERT ON job_milestone_events
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_addon_id_collision();
CREATE TRIGGER zz_milestone_ack_addon_collision BEFORE INSERT ON job_milestone_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_addon_id_collision();

CREATE TRIGGER job_milestone_proposal_validate BEFORE INSERT ON job_milestone_proposals
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_context_insert();
CREATE TRIGGER job_milestone_proposal_decision_validate BEFORE INSERT ON job_milestone_proposal_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_context_insert();
CREATE TRIGGER job_milestone_comment_validate BEFORE INSERT ON job_milestone_comments
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_context_insert();
CREATE TRIGGER job_milestone_media_validate BEFORE INSERT ON job_milestone_media
  FOR EACH ROW EXECUTE FUNCTION validate_job_milestone_context_insert();
CREATE TRIGGER job_milestone_proposal_immutable BEFORE UPDATE OR DELETE ON job_milestone_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();
CREATE TRIGGER job_milestone_proposal_decision_immutable BEFORE UPDATE OR DELETE ON job_milestone_proposal_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();
CREATE TRIGGER job_milestone_comment_immutable BEFORE UPDATE OR DELETE ON job_milestone_comments
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();
CREATE TRIGGER job_milestone_media_immutable BEFORE UPDATE OR DELETE ON job_milestone_media
  FOR EACH ROW EXECUTE FUNCTION reject_job_milestone_mutation();

COMMENT ON TABLE job_milestone_proposals IS 'Customer suggestion, never an authoritative execution or commercial edit.';
COMMENT ON TABLE job_milestone_proposal_decisions IS 'Planner decision pinned to one matching same-transaction plan event.';
COMMENT ON TABLE job_milestone_comments IS 'Private context/disagreement, not automatic dispute or forced state rollback.';
COMMENT ON TABLE job_milestone_media IS 'Reference to central READY/private exact-Job documentation, no copied object.';
