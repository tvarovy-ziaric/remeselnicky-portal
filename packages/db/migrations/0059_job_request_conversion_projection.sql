-- The immutable Job is the conversion event. The historical ACTIVE request
-- revision remains untouched; every operational read sees CONVERTED.
CREATE OR REPLACE VIEW current_job_requests AS
SELECT DISTINCT ON (request.id)
  request.id,
  request.customer_profile_id,
  CASE WHEN EXISTS (
    SELECT 1 FROM jobs job WHERE job.job_request_id = request.id
  ) THEN 'CONVERTED'::job_request_state ELSE revision.state END AS state,
  revision.revision,
  request.created_at,
  revision.changed_at,
  revision.activated_at,
  revision.expires_at,
  revision.cancellation_reason
FROM job_requests request
JOIN job_request_revisions revision ON revision.job_request_id = request.id
ORDER BY request.id, revision.revision DESC;

COMMENT ON VIEW current_job_requests IS
  'Operational request state derives CONVERTED from the one immutable primary Job; pre-contract lifecycle revisions remain historical.';
