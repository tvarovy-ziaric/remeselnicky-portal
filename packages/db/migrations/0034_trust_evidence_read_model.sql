-- R2-008 exposes sparse, explainable trust/evidence facts only. R4 owns the
-- future completed-job/review sources and any reviewed confidence policy.
CREATE VIEW current_searchable_trust_evidence_summaries
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  0::integer AS customer_review_count,
  0::integer AS supervisor_evaluation_count,
  0::integer AS verified_job_count,
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

CREATE VIEW current_searchable_profession_trust_evidence
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
  0::integer AS verified_job_count,
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

COMMENT ON VIEW current_searchable_trust_evidence_summaries IS
  'Sparse public-search trust/evidence facts. Volume, quality and confidence stay separate; zero history is neutral, not a zero rating. Credential/project counts are factual only and are not rank weights or source-diversity proxies.';

COMMENT ON VIEW current_searchable_profession_trust_evidence IS
  'Profession-scoped sparse trust/evidence facts using exact governed profession relevance. No private review/evaluator text, party identity, provenance identifier or ranking coefficient is exposed.';
