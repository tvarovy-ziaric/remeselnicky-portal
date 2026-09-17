-- R4-016: factual completed-Job involvement is separate from a review score.
-- Completion provenance remains explicit: an admin correction is not customer
-- acceptance, and contractual company history is not an owner's work history.
CREATE VIEW completed_job_evidence_provenance
WITH (security_invoker = true)
AS
SELECT job.id AS job_id,
  job.customer_profile_id,
  job.primary_craftsman_profile_id,
  qualification.profession_code AS accepted_profession_code,
  COALESCE(customer_acceptance.decided_at, admin_completion.recorded_at)
    AS completed_at,
  COALESCE(customer_acceptance.actor_user_id, admin_completion.actor_user_id)
    AS completed_by_user_id,
  CASE WHEN admin_completion.command_id IS NOT NULL
    THEN 'ADMIN_FORCED' ELSE 'CUSTOMER_ACCEPTED' END AS completion_kind,
  customer_acceptance.id AS completion_decision_id,
  admin_completion.command_id AS admin_completion_command_id
FROM jobs job
JOIN job_acceptance_events accepted ON accepted.job_id = job.id
JOIN job_agreement_snapshots agreement ON agreement.job_id = job.id
JOIN job_qualification_snapshots qualification ON qualification.job_id = job.id
JOIN current_job_states state ON state.job_id = job.id
  AND state.state = 'COMPLETED'
LEFT JOIN LATERAL (
  SELECT decision.id, decision.decided_at, decision.actor_user_id
  FROM job_completion_attempts attempt
  JOIN job_completion_decisions decision ON decision.attempt_id = attempt.id
    AND decision.kind = 'ACCEPT'
  WHERE attempt.job_id = job.id
  ORDER BY attempt.attempt_number DESC LIMIT 1
) customer_acceptance ON true
LEFT JOIN job_admin_completion_commands admin_completion
  ON admin_completion.job_id = job.id
WHERE (customer_acceptance.id IS NOT NULL)
  <> (admin_completion.command_id IS NOT NULL);

CREATE VIEW verified_company_completed_jobs
WITH (security_invoker = true)
AS
SELECT evidence.job_id, evidence.customer_profile_id,
  evidence.primary_craftsman_profile_id AS company_profile_id,
  evidence.accepted_profession_code, evidence.completed_at,
  evidence.completed_by_user_id, evidence.completion_kind,
  evidence.completion_decision_id, evidence.admin_completion_command_id
FROM completed_job_evidence_provenance evidence
JOIN craftsman_profiles company
  ON company.id = evidence.primary_craftsman_profile_id
  AND company.profile_type = 'COMPANY';

CREATE VIEW verified_individual_completed_job_participation
WITH (security_invoker = true)
AS
SELECT evidence.job_id, evidence.customer_profile_id,
  participant.id AS participant_id,
  participant.craftsman_profile_id AS individual_profile_id,
  participant.accepted_at AS participation_started_at,
  LEAST(participant.left_at, evidence.completed_at) AS participation_ended_at,
  participant.left_at IS NOT NULL AS left_before_completion,
  participant.accepted_by_user_id,
  evidence.completed_at, evidence.completed_by_user_id,
  evidence.completion_kind, evidence.completion_decision_id,
  evidence.admin_completion_command_id
FROM completed_job_evidence_provenance evidence
JOIN current_job_participants participant ON participant.job_id = evidence.job_id
  AND participant.verified_participation
  AND participant.accepted_at <= evidence.completed_at
JOIN craftsman_profiles individual
  ON individual.id = participant.craftsman_profile_id
  AND individual.profile_type = 'INDIVIDUAL';

-- A provider-assigned role alone is not precise verified role evidence. Only
-- bilateral capability confirmations completed before Job closure qualify.
CREATE VIEW verified_completed_job_capabilities
WITH (security_invoker = true)
AS
SELECT participation.job_id, participation.participant_id,
  participation.individual_profile_id,
  capability.claim_id, capability.kind,
  capability.profession_taxonomy_release_id, capability.profession_code,
  capability.skill_catalog_release_id, capability.skill_code,
  capability.custom_skill_text, capability.proposed_by_user_id,
  capability.proposed_at, capability.confirmed_by_user_id,
  capability.confirmed_at, participation.completed_at,
  participation.completion_kind
FROM verified_individual_completed_job_participation participation
JOIN confirmed_job_participant_capability_evidence capability
  ON capability.participant_id = participation.participant_id
  AND capability.confirmed_at <= participation.completed_at;

CREATE FUNCTION block_closed_job_participant_departure()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job_id uuid; actual_state job_state;
BEGIN
  IF NEW.event_kind NOT IN ('LEAVE', 'REMOVE') THEN RETURN NEW; END IF;
  SELECT job_id INTO target_job_id FROM job_participants
    WHERE id = NEW.participant_id;
  IF target_job_id IS NULL THEN RAISE EXCEPTION 'Job participant required'; END IF;
  PERFORM 1 FROM jobs WHERE id = target_job_id FOR UPDATE;
  SELECT state INTO actual_state FROM current_job_states
    WHERE job_id = target_job_id;
  IF actual_state NOT IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETION_REQUESTED') THEN
    RAISE EXCEPTION 'closed Job participation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_participant_event_closed_job_guard
BEFORE INSERT ON job_participant_events
FOR EACH ROW EXECUTE FUNCTION block_closed_job_participant_departure();

COMMENT ON VIEW completed_job_evidence_provenance IS
  'Private exact completion source; admin action never impersonates customer acceptance.';
COMMENT ON VIEW verified_company_completed_jobs IS
  'Private company contractual completed-Job history, not owner-level individual work evidence.';
COMMENT ON VIEW verified_individual_completed_job_participation IS
  'Private factual completed-Job involvement from explicit accepted participation, including earlier leavers; invitation alone is insufficient.';
COMMENT ON VIEW verified_completed_job_capabilities IS
  'Private bilateral profession/skill evidence at Job completion; no self-declared profile rewrite or unilateral role verification.';
