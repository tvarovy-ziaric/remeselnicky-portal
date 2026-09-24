-- R4-017 activates public-safe customer review reputation only after the
-- bilateral seal opens. Each review contributes one equally weighted score;
-- dimensions marked N/A stay outside that review score.
CREATE VIEW current_unlocked_provider_main_review_scores
WITH (security_invoker = true)
AS
SELECT review.revision_id, review.target_profile_id AS craftsman_profile_id,
  review.accepted_profession_code AS profession_code,
  round(avg((rating.value #>> '{}')::numeric), 2) AS review_score
FROM current_unlocked_job_main_reviews review
CROSS JOIN LATERAL jsonb_each(review.ratings) rating
WHERE review.direction = 'CUSTOMER_TO_PROVIDER'
  AND review.target_kind = 'CRAFTSMAN_PROFILE'
  AND jsonb_typeof(rating.value) = 'number'
GROUP BY review.revision_id, review.target_profile_id,
  review.accepted_profession_code;

CREATE OR REPLACE VIEW current_searchable_trust_evidence_summaries
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  COALESCE(reputation.review_count, 0)::integer AS customer_review_count,
  0::integer AS supervisor_evaluation_count,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profile_evidence completed
    WHERE completed.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS verified_job_count,
  CASE WHEN COALESCE(reputation.review_count, 0) > 0
    THEN 1 ELSE 0 END::integer AS independent_evidence_source_count,
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
  reputation.customer_score,
  COALESCE(reputation.review_count, 0) > 0 AS customer_quality_available,
  false AS supervisor_quality_available,
  'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence,
  'INSUFFICIENT_SAMPLE'::text AS supervisor_evidence_confidence,
  'INSUFFICIENT_SAMPLE'::text AS source_diversity_confidence
FROM current_searchable_craftsman_profiles searchable
LEFT JOIN LATERAL (
  SELECT round(avg(review.review_score), 2)::numeric AS customer_score,
    count(*)::integer AS review_count
  FROM current_unlocked_provider_main_review_scores review
  WHERE review.craftsman_profile_id = searchable.craftsman_profile_id
) reputation ON true;

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
  COALESCE(reputation.review_count, 0)::integer AS customer_review_count,
  0::integer AS supervisor_evaluation_count,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profession_evidence completed
    WHERE completed.craftsman_profile_id = profession.craftsman_profile_id
      AND completed.profession_code = profession.profession_code
  ) AS verified_job_count,
  CASE WHEN COALESCE(reputation.review_count, 0) > 0
    THEN 1 ELSE 0 END::integer AS independent_evidence_source_count,
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
  reputation.customer_score,
  COALESCE(reputation.review_count, 0) > 0 AS customer_quality_available,
  false AS supervisor_quality_available,
  'INSUFFICIENT_SAMPLE'::text AS customer_score_confidence,
  'INSUFFICIENT_SAMPLE'::text AS supervisor_evidence_confidence,
  'INSUFFICIENT_SAMPLE'::text AS source_diversity_confidence
FROM current_searchable_craftsman_professions profession
LEFT JOIN LATERAL (
  SELECT round(avg(review.review_score), 2)::numeric AS customer_score,
    count(*)::integer AS review_count
  FROM current_unlocked_provider_main_review_scores review
  WHERE review.craftsman_profile_id = profession.craftsman_profile_id
    AND review.profession_code = profession.profession_code
) reputation ON true;

CREATE OR REPLACE VIEW current_searchable_craftsman_trust_signals
WITH (security_invoker = true)
AS
SELECT searchable.craftsman_profile_id,
  reputation.customer_score,
  COALESCE(reputation.review_count, 0)::integer AS review_count,
  false AS review_sample_sufficient,
  (
    SELECT count(DISTINCT completed.job_id)::integer
    FROM completed_job_profile_evidence completed
    WHERE completed.craftsman_profile_id = searchable.craftsman_profile_id
  ) AS verified_work_count
FROM current_searchable_craftsman_profiles searchable
LEFT JOIN LATERAL (
  SELECT round(avg(review.review_score), 2)::numeric AS customer_score,
    count(*)::integer AS review_count
  FROM current_unlocked_provider_main_review_scores review
  WHERE review.craftsman_profile_id = searchable.craftsman_profile_id
) reputation ON true;

COMMENT ON VIEW current_unlocked_provider_main_review_scores IS
  'Unlocked customer-to-provider per-review scores only. No Job, customer, author, comment, address or contact identity is projected.';
COMMENT ON VIEW current_searchable_trust_evidence_summaries IS
  'Public-safe unlocked customer review quality plus factual evidence volume for searchable profiles; small-sample confidence remains explicitly insufficient.';
COMMENT ON VIEW current_searchable_profession_trust_evidence IS
  'Public-safe profession-scoped unlocked customer review quality and evidence volume; no raw review or private provenance is exposed.';
COMMENT ON VIEW current_searchable_craftsman_trust_signals IS
  'Search-card unlocked customer review score/count and verified work volume; review_sample_sufficient stays false until a governed confidence policy exists.';
