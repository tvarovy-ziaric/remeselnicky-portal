-- D28/R4-027: privacy-minimal, entity-aware facts derived from authoritative
-- domain state. These views contain no chat/review/dispute text, exact address,
-- contact data, document metadata or raw search query.

CREATE TABLE r4_analytics_search_facts (
  search_id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  traffic_class analytics_traffic_class NOT NULL,
  profession_code text NOT NULL CHECK (
    profession_code ~ '^PROF:[A-Z0-9][A-Z0-9_]{1,62}$'
  ),
  region_code text REFERENCES location_regions(code) ON DELETE RESTRICT,
  result_count_bucket text NOT NULL CHECK (
    result_count_bucket IN ('ZERO', 'ONE_TO_FOUR', 'FIVE_PLUS')
  ),
  candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 100),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT r4_analytics_search_result_coherence CHECK (
    (result_count_bucket = 'ZERO' AND candidate_count = 0)
    OR (result_count_bucket = 'ONE_TO_FOUR'
      AND candidate_count BETWEEN 1 AND 4)
    OR (result_count_bucket = 'FIVE_PLUS'
      AND candidate_count BETWEEN 5 AND 100)
  )
);

CREATE TABLE r4_analytics_search_profile_open_facts (
  search_id uuid PRIMARY KEY
    REFERENCES r4_analytics_search_facts(search_id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION normalize_r4_analytics_search_fact()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL THEN
    PERFORM 1 FROM users WHERE id = NEW.actor_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'analytics search actor required'; END IF;
    NEW.traffic_class := r3_analytics_traffic_class(NEW.actor_user_id);
  ELSE
    NEW.traffic_class := 'REAL';
  END IF;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER r4_analytics_search_fact_normalize
BEFORE INSERT ON r4_analytics_search_facts
FOR EACH ROW EXECUTE FUNCTION normalize_r4_analytics_search_fact();

CREATE FUNCTION normalize_r4_analytics_search_profile_open_fact()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM r4_analytics_search_facts fact
  WHERE fact.search_id = NEW.search_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'analytics search fact required'; END IF;
  NEW.occurred_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER r4_analytics_search_profile_open_fact_normalize
BEFORE INSERT ON r4_analytics_search_profile_open_facts
FOR EACH ROW EXECUTE FUNCTION normalize_r4_analytics_search_profile_open_fact();

CREATE FUNCTION reject_r4_analytics_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'analytics facts are append-only'; END;
$$;

CREATE TRIGGER r4_analytics_search_facts_append_only
BEFORE UPDATE OR DELETE ON r4_analytics_search_facts
FOR EACH ROW EXECUTE FUNCTION reject_r4_analytics_fact_mutation();
CREATE TRIGGER r4_analytics_search_profile_open_facts_append_only
BEFORE UPDATE OR DELETE ON r4_analytics_search_profile_open_facts
FOR EACH ROW EXECUTE FUNCTION reject_r4_analytics_fact_mutation();

CREATE VIEW r4_alpha_search_liquidity_facts
WITH (security_invoker = true)
AS
SELECT fact.search_id, fact.traffic_class, fact.occurred_at,
  fact.profession_code, fact.region_code, fact.result_count_bucket,
  open_fact.search_id IS NOT NULL AS profile_opened, fact.candidate_count
FROM r4_analytics_search_facts fact
LEFT JOIN r4_analytics_search_profile_open_facts open_fact
  ON open_fact.search_id = fact.search_id;

CREATE VIEW r4_alpha_request_journey_facts
WITH (security_invoker = true)
AS
WITH submitted AS (
  SELECT request.id AS request_id, request.customer_profile_id,
    min(revision.activated_at) AS submitted_at
  FROM job_requests request
  JOIN job_request_revisions revision
    ON revision.job_request_id = request.id
    AND revision.activated_at IS NOT NULL
  GROUP BY request.id, request.customer_profile_id
), dimensions AS (
  SELECT section.job_request_id,
    max(section.payload ->> 'primaryProfessionCode') FILTER (
      WHERE section.section_key = 'request.core'
    ) AS profession_code,
    max(region.code) FILTER (
      WHERE section.section_key = 'request.location'
    ) AS region_code
  FROM job_request_active_section_revisions section
  LEFT JOIN location_municipalities municipality
    ON municipality.code = section.payload ->> 'municipalityCode'
    AND section.section_key = 'request.location'
  LEFT JOIN location_districts district
    ON district.code = municipality.district_code
  LEFT JOIN location_regions region ON region.code = district.region_code
  WHERE section.content_revision = 1
    AND section.section_key IN ('request.core', 'request.location')
  GROUP BY section.job_request_id
), invitations AS (
  SELECT invitation.job_request_id,
    count(DISTINCT invitation.id)::integer AS invitation_count,
    min(revision.engaged_at) AS first_engaged_at
  FROM job_invitations invitation
  LEFT JOIN job_invitation_revisions revision
    ON revision.invitation_id = invitation.id
  GROUP BY invitation.job_request_id
), submitted_quotes AS (
  SELECT invitation.job_request_id,
    count(DISTINCT quote.id)::integer AS quote_count,
    min(state.submitted_at) AS first_quote_at
  FROM job_invitations invitation
  JOIN quotes quote ON quote.invitation_id = invitation.id
  JOIN quote_revision_state_events state ON state.quote_id = quote.id
    AND state.submitted_at IS NOT NULL
  GROUP BY invitation.job_request_id
), process AS (
  SELECT job.id AS job_id,
    (SELECT count(*)::integer FROM job_completion_attempts attempt
      WHERE attempt.job_id = job.id) AS completion_attempt_count,
    (SELECT count(*)::integer FROM change_orders change_order
      WHERE change_order.job_id = job.id) AS change_order_count,
    (SELECT count(*)::integer FROM dispute_cases dispute
      WHERE dispute.job_id = job.id) AS dispute_count
  FROM jobs job
), review_reports AS (
  SELECT review.job_id, count(*)::integer AS report_count
  FROM moderation_reports report
  JOIN job_main_review_events review
    ON report.target_type = 'MAIN_REVIEW'
    AND review.event_id = report.target_id
  GROUP BY review.job_id
), response_reports AS (
  SELECT response.job_id, count(*)::integer AS report_count
  FROM moderation_reports report
  JOIN job_main_review_responses response
    ON report.target_type = 'REVIEW_RESPONSE'
    AND response.response_id = report.target_id
  GROUP BY response.job_id
), supervisor_reports AS (
  SELECT evaluation.job_id, count(*)::integer AS report_count
  FROM moderation_reports report
  JOIN job_supervisor_evaluations evaluation
    ON report.target_type = 'SUPERVISOR_EVALUATION'
    AND evaluation.evaluation_id = report.target_id
  GROUP BY evaluation.job_id
), first_review AS (
  SELECT review.job_id, min(review.recorded_at) AS reviewed_at
  FROM job_main_review_events review WHERE review.version = 1
  GROUP BY review.job_id
)
SELECT submitted.request_id,
  CASE
    WHEN r3_analytics_traffic_class(customer.owner_user_id) = 'TEST'
      OR EXISTS (
        SELECT 1 FROM job_invitations invited
        JOIN craftsman_profiles provider
          ON provider.id = invited.craftsman_profile_id
        WHERE invited.job_request_id = submitted.request_id
          AND r3_analytics_traffic_class(provider.owner_user_id) = 'TEST'
      ) THEN 'TEST'::analytics_traffic_class
    WHEN r3_analytics_traffic_class(customer.owner_user_id) = 'INTERNAL'
      OR EXISTS (
        SELECT 1 FROM job_invitations invited
        JOIN craftsman_profiles provider
          ON provider.id = invited.craftsman_profile_id
        WHERE invited.job_request_id = submitted.request_id
          AND r3_analytics_traffic_class(provider.owner_user_id) = 'INTERNAL'
      ) THEN 'INTERNAL'::analytics_traffic_class
    ELSE 'REAL'::analytics_traffic_class
  END AS traffic_class,
  submitted.submitted_at, dimensions.profession_code, dimensions.region_code,
  invitations.first_engaged_at, submitted_quotes.first_quote_at,
  coalesce(submitted_quotes.quote_count, 0) AS quote_count,
  job.id AS job_id, job.accepted_at AS confirmed_at, state.started_at,
  completed.completed_at, first_review.reviewed_at,
  coalesce(invitations.invitation_count, 0) AS invitation_count,
  coalesce(process.completion_attempt_count, 0) AS completion_attempt_count,
  coalesce(process.change_order_count, 0) AS change_order_count,
  coalesce(process.dispute_count, 0) AS dispute_count,
  coalesce(review_reports.report_count, 0)
    + coalesce(response_reports.report_count, 0)
    + coalesce(supervisor_reports.report_count, 0) AS report_count
FROM submitted
JOIN customer_profiles customer ON customer.id = submitted.customer_profile_id
JOIN dimensions ON dimensions.job_request_id = submitted.request_id
LEFT JOIN invitations ON invitations.job_request_id = submitted.request_id
LEFT JOIN submitted_quotes
  ON submitted_quotes.job_request_id = submitted.request_id
LEFT JOIN jobs job ON job.job_request_id = submitted.request_id
LEFT JOIN current_job_states state ON state.job_id = job.id
LEFT JOIN completed_job_evidence_provenance completed
  ON completed.job_id = job.id
LEFT JOIN process ON process.job_id = job.id
LEFT JOIN review_reports ON review_reports.job_id = job.id
LEFT JOIN response_reports ON response_reports.job_id = job.id
LEFT JOIN supervisor_reports ON supervisor_reports.job_id = job.id
LEFT JOIN first_review ON first_review.job_id = job.id;

CREATE VIEW r4_alpha_supply_facts
WITH (security_invoker = true)
AS
WITH profile_dimensions AS (
  SELECT searchable.craftsman_profile_id, profile.owner_user_id,
    profession.profession_code, region.code AS region_code
  FROM current_searchable_craftsman_profiles searchable
  JOIN craftsman_profiles profile
    ON profile.id = searchable.craftsman_profile_id
  JOIN current_searchable_craftsman_professions profession
    ON profession.craftsman_profile_id = searchable.craftsman_profile_id
  JOIN location_municipalities municipality
    ON municipality.code = searchable.base_municipality_code
  JOIN location_districts district
    ON district.code = municipality.district_code
  JOIN location_regions region ON region.code = district.region_code
), request_professions AS (
  SELECT section.job_request_id,
    section.payload ->> 'primaryProfessionCode' AS profession_code
  FROM job_request_active_section_revisions section
  WHERE section.content_revision = 1 AND section.section_key = 'request.core'
), invitation_activity AS (
  SELECT invitation.craftsman_profile_id, requested.profession_code,
    count(DISTINCT invitation.id)::integer AS invitation_count,
    count(DISTINCT invitation.id) FILTER (
      WHERE revision.engaged_at IS NOT NULL
    )::integer AS engaged_count,
    count(DISTINCT quote.id) FILTER (
      WHERE quote_state.submitted_at IS NOT NULL
    )::integer AS quote_count
  FROM job_invitations invitation
  JOIN request_professions requested
    ON requested.job_request_id = invitation.job_request_id
  LEFT JOIN job_invitation_revisions revision
    ON revision.invitation_id = invitation.id
  LEFT JOIN quotes quote ON quote.invitation_id = invitation.id
  LEFT JOIN quote_revision_state_events quote_state
    ON quote_state.quote_id = quote.id
  GROUP BY invitation.craftsman_profile_id, requested.profession_code
), won_activity AS (
  SELECT job.primary_craftsman_profile_id AS craftsman_profile_id,
    qualification.profession_code,
    count(DISTINCT job.id)::integer AS won_job_count,
    count(DISTINCT completed.job_id)::integer AS completed_job_count
  FROM jobs job
  JOIN job_qualification_snapshots qualification
    ON qualification.job_id = job.id
  LEFT JOIN completed_job_evidence_provenance completed
    ON completed.job_id = job.id
  GROUP BY job.primary_craftsman_profile_id, qualification.profession_code
)
SELECT profile.craftsman_profile_id,
  r3_analytics_traffic_class(profile.owner_user_id) AS traffic_class,
  profile.profession_code, profile.region_code,
  coalesce(invitation.invitation_count, 0) AS invitation_count,
  coalesce(invitation.engaged_count, 0) AS engaged_count,
  coalesce(invitation.quote_count, 0) AS quote_count,
  coalesce(won.won_job_count, 0) AS won_job_count,
  coalesce(won.completed_job_count, 0) AS completed_job_count
FROM profile_dimensions profile
LEFT JOIN invitation_activity invitation
  ON invitation.craftsman_profile_id = profile.craftsman_profile_id
  AND invitation.profession_code = profile.profession_code
LEFT JOIN won_activity won
  ON won.craftsman_profile_id = profile.craftsman_profile_id
  AND won.profession_code = profile.profession_code;

COMMENT ON TABLE r4_analytics_search_facts IS
  'Privacy-minimal authoritative search completion facts; no query text, coordinates, profile identities or arbitrary payload.';
COMMENT ON TABLE r4_analytics_search_profile_open_facts IS
  'One content-free result-open fact per completed search; read/click is not business conversion.';
COMMENT ON VIEW r4_alpha_request_journey_facts IS
  'One entity-aware row per submitted request cohort with server-time marketplace outcomes and no user-authored content.';
COMMENT ON VIEW r4_alpha_supply_facts IS
  'One row per current public profile/profession/region; activity is attributed to the request or accepted Job profession.';

REVOKE ALL ON r4_analytics_search_facts FROM PUBLIC;
REVOKE ALL ON r4_analytics_search_profile_open_facts FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION normalize_r4_analytics_search_fact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION normalize_r4_analytics_search_profile_open_fact()
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reject_r4_analytics_fact_mutation() FROM PUBLIC;
