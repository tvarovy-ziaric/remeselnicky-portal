-- D18/D19: explicit operational plan provenance; no milestone is commercial authority.
ALTER TABLE job_milestone_events
  ADD COLUMN source_change_order_revision_id uuid
    REFERENCES change_order_revisions(id) ON DELETE RESTRICT;

CREATE OR REPLACE VIEW current_job_milestones AS
SELECT milestone.id, milestone.job_id, milestone.created_by_user_id, milestone.created_at,
  latest.event_id, latest.event_sequence, latest.title, latest.description,
  latest.planned_start_date, latest.planned_end_date, latest.state,
  latest.order_key, latest.responsible_participant_id,
  latest.responsible_work_group_id, latest.accepted_stage_label,
  latest.accepted_quote_id, latest.accepted_quote_revision,
  latest.accepted_pdf_media_asset_id, latest.recorded_at AS updated_at,
  latest.source_change_order_revision_id
FROM job_milestones milestone
JOIN LATERAL (
  SELECT * FROM job_milestone_events event
  WHERE event.milestone_id = milestone.id
  ORDER BY event.event_sequence DESC LIMIT 1
) latest ON true;

CREATE FUNCTION validate_job_milestone_change_order_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id uuid;
  previous_revision_id uuid;
  approved_revision_job_id uuid;
  affected_milestones uuid[];
BEGIN
  SELECT job_id INTO target_job_id FROM job_milestones WHERE id = NEW.milestone_id;
  SELECT source_change_order_revision_id INTO previous_revision_id
    FROM job_milestone_events WHERE milestone_id = NEW.milestone_id
    ORDER BY event_sequence DESC LIMIT 1;
  IF NEW.kind <> 'CREATE' AND NEW.source_change_order_revision_id IS NULL THEN
    NEW.source_change_order_revision_id := previous_revision_id;
  END IF;
  IF NEW.source_change_order_revision_id IS NOT DISTINCT FROM previous_revision_id THEN
    RETURN NEW;
  END IF;
  IF NEW.source_change_order_revision_id IS NULL
    OR NEW.kind NOT IN ('CREATE', 'EDIT')
    OR (NEW.kind = 'CREATE' AND NEW.accepted_stage_label IS NOT NULL)
    OR job_milestone_actor_role(target_job_id, NEW.actor_user_id)
      IS DISTINCT FROM 'PRIMARY_PROVIDER' THEN
    RAISE EXCEPTION 'approved Change-order provenance requires provider plan event';
  END IF;
  SELECT change.job_id, revision.affected_milestone_ids
    INTO approved_revision_job_id, affected_milestones
    FROM change_order_revisions revision
    JOIN change_orders change ON change.id = revision.change_order_id
    JOIN current_change_order_revision_states state ON state.revision_id = revision.id
    WHERE revision.id = NEW.source_change_order_revision_id AND state.state = 'APPROVED';
  IF approved_revision_job_id IS DISTINCT FROM target_job_id THEN
    RAISE EXCEPTION 'approved exact-Job Change-order revision required';
  END IF;
  IF NEW.kind = 'EDIT' AND NOT NEW.milestone_id = ANY(affected_milestones) THEN
    RAISE EXCEPTION 'Change-order revision did not identify edited milestone';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER milestone_revision_provenance_validate
  BEFORE INSERT ON job_milestone_events FOR EACH ROW
  EXECUTE FUNCTION validate_job_milestone_change_order_provenance();

COMMENT ON COLUMN job_milestone_events.source_change_order_revision_id IS
  'Exact approved D19 revision attributed to a milestone CREATE/EDIT plan event; not a price or payment obligation.';
