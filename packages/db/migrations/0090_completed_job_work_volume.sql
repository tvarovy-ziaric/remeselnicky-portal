-- R4-016: accepting an invitation before work starts is participation history,
-- not evidence of performed work. A verified interval must overlap execution.
CREATE OR REPLACE VIEW verified_individual_completed_job_participation
WITH (security_invoker = true)
AS
SELECT evidence.job_id, evidence.customer_profile_id,
  participant.id AS participant_id,
  participant.craftsman_profile_id AS individual_profile_id,
  GREATEST(participant.accepted_at, job_state.started_at)
    AS participation_started_at,
  LEAST(participant.left_at, evidence.completed_at) AS participation_ended_at,
  participant.left_at IS NOT NULL AS left_before_completion,
  participant.accepted_by_user_id,
  evidence.completed_at, evidence.completed_by_user_id,
  evidence.completion_kind, evidence.completion_decision_id,
  evidence.admin_completion_command_id,
  participant.accepted_at AS participation_accepted_at
FROM completed_job_evidence_provenance evidence
JOIN current_job_states job_state ON job_state.job_id = evidence.job_id
  AND job_state.started_at IS NOT NULL
JOIN current_job_participants participant ON participant.job_id = evidence.job_id
  AND participant.verified_participation
  AND participant.accepted_at < evidence.completed_at
  AND LEAST(participant.left_at, evidence.completed_at)
    > GREATEST(participant.accepted_at, job_state.started_at)
JOIN craftsman_profiles individual
  ON individual.id = participant.craftsman_profile_id
  AND individual.profile_type = 'INDIVIDUAL';

-- These are private provenance views. Only the aggregate counts below enter
-- searchable projections; Job/customer/participant identities never do.
CREATE VIEW completed_job_profile_evidence
WITH (security_invoker = true)
AS
SELECT job_id, company_profile_id AS craftsman_profile_id
FROM verified_company_completed_jobs
UNION ALL
SELECT job_id, individual_profile_id
FROM verified_individual_completed_job_participation;

CREATE VIEW completed_job_profession_evidence
WITH (security_invoker = true)
AS
SELECT job_id, company_profile_id AS craftsman_profile_id,
  accepted_profession_code AS profession_code
FROM verified_company_completed_jobs
UNION ALL
SELECT job_id, individual_profile_id, profession_code
FROM verified_completed_job_capabilities
WHERE kind = 'PROFESSION';

CREATE OR REPLACE VIEW current_searchable_trust_evidence_summaries
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  0::integer AS customer_review_count,
  0::integer AS supervisor_evaluation_count,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profile_evidence completed
    WHERE completed.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS verified_job_count,
  0::integer AS independent_evidence_source_count,
  (
    SELECT count(DISTINCT credential.credential_type_code)::integer
    FROM current_searchable_craftsman_credentials credential
    WHERE credential.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS approved_credential_type_count,
  (
    SELECT count(DISTINCT project.portfolio_project_id)::integer
    FROM current_public_portfolio_projects project
    WHERE project.craftsman_profile_id = searchable.craftsman_profile_id
      AND project.evidence_status = 'VERIFIED'
  ) AS verified_portfolio_project_count,
  NULL::numeric AS customer_score,
  false AS customer_quality_available,
  false AS supervisor_quality_available,
  'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence,
  'INSUFFICIENT_SAMPLE'::text AS supervisor_evidence_confidence,
  'INSUFFICIENT_SAMPLE'::text AS source_diversity_confidence
FROM current_searchable_craftsman_profiles searchable;

CREATE OR REPLACE VIEW current_searchable_profession_trust_evidence
WITH (security_invoker = true)
AS
SELECT
  profession.craftsman_profile_id,
  profession.profession_code,
  profession.evidence_supported_level,
  EXISTS (
    SELECT 1
    FROM current_searchable_craftsman_specializations specialization
    WHERE specialization.craftsman_profile_id = profession.craftsman_profile_id
      AND specialization.profession_code = profession.profession_code
      AND specialization.evidence_supported
  ) AS has_evidence_supported_specialization,
  EXISTS (
    SELECT 1
    FROM current_searchable_craftsman_skills skill
    WHERE skill.craftsman_profile_id = profession.craftsman_profile_id
      AND profession.profession_code = ANY(skill.profession_codes)
      AND skill.evidence_supported
  ) AS has_evidence_supported_skill,
  0::integer AS customer_review_count,
  0::integer AS supervisor_evaluation_count,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profession_evidence completed
    WHERE completed.craftsman_profile_id = profession.craftsman_profile_id
      AND completed.profession_code = profession.profession_code
  ) AS verified_job_count,
  0::integer AS independent_evidence_source_count,
  (
    SELECT count(DISTINCT credential.credential_type_code)::integer
    FROM current_searchable_craftsman_credentials credential
    WHERE credential.craftsman_profile_id = profession.craftsman_profile_id
      AND credential.profession_code = profession.profession_code
  ) AS approved_credential_type_count,
  (
    SELECT count(DISTINCT public_project.portfolio_project_id)::integer
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project
      ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_professions project_profession
      ON project_profession.id = ANY(project.profession_ids)
      AND project_profession.craftsman_profile_id =
        profession.craftsman_profile_id
      AND project_profession.profession_code = profession.profession_code
      AND project_profession.state = 'ACTIVE'
    WHERE public_project.craftsman_profile_id = profession.craftsman_profile_id
      AND public_project.evidence_status = 'VERIFIED'
  ) AS verified_portfolio_project_count,
  NULL::numeric AS customer_score,
  false AS customer_quality_available,
  false AS supervisor_quality_available,
  'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence,
  'INSUFFICIENT_SAMPLE'::text AS supervisor_evidence_confidence,
  'INSUFFICIENT_SAMPLE'::text AS source_diversity_confidence
FROM current_searchable_craftsman_professions profession;

CREATE OR REPLACE VIEW current_searchable_craftsman_trust_signals
WITH (security_invoker = true)
AS
SELECT searchable.craftsman_profile_id,
  NULL::numeric AS customer_score,
  0::integer AS review_count,
  false AS review_sample_sufficient,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profile_evidence completed
    WHERE completed.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS verified_work_count
FROM current_searchable_craftsman_profiles searchable;

COMMENT ON VIEW completed_job_profile_evidence IS
  'Private distinct-count source for factual Job volume; never expose Job IDs from public search.';
COMMENT ON VIEW completed_job_profession_evidence IS
  'Private exact profession count source: company agreement profession or bilaterally confirmed individual capability only.';
COMMENT ON VIEW current_searchable_trust_evidence_summaries IS
  'Public-safe aggregate verified Job volume for searchable profiles; zero history is neutral, not a zero rating.';
COMMENT ON VIEW current_searchable_profession_trust_evidence IS
  'Public-safe exact profession Job volume; unconfirmed individual profession claims do not count.';
COMMENT ON VIEW current_searchable_craftsman_trust_signals IS
  'Cold-start-neutral searchable trust signal with factual distinct completed-work volume and no private Job identifiers.';
