-- R2-007 derives only a categorical, indicative availability overlap from the
-- private calendar. Exact markings remain private and no result is a booking,
-- capacity statement, full-interval coverage, or contractual guarantee.

CREATE TYPE craftsman_availability_match_kind AS ENUM (
  'TIMING_NOT_SUPPLIED',
  'NO_OVERLAPPING_DECLARATION',
  'AVAILABLE_OVERLAP',
  'BUSY_OVERLAP',
  'UNAVAILABLE_OVERLAP',
  'MIXED_OVERLAP'
);

CREATE FUNCTION craftsman_availability_match_facts(
  query_starts_at timestamptz,
  query_ends_at timestamptz,
  filter_indicatively_available boolean
)
RETURNS TABLE (
  craftsman_profile_id uuid,
  match_kind craftsman_availability_match_kind,
  indicatively_available boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH query_guard AS (
    SELECT
      query_starts_at AS starts_at,
      query_ends_at AS ends_at,
      filter_indicatively_available AS filter_available
    WHERE filter_indicatively_available IS NOT NULL
      AND (
        (query_starts_at IS NULL AND query_ends_at IS NULL
          AND NOT filter_indicatively_available)
        OR (
          query_starts_at IS NOT NULL
          AND query_ends_at IS NOT NULL
          AND isfinite(query_starts_at)
          AND isfinite(query_ends_at)
          AND query_starts_at >= timestamptz '2000-01-01 00:00:00+00'
          AND query_ends_at <= timestamptz '2200-01-01 00:00:00+00'
          AND query_starts_at < query_ends_at
          AND query_ends_at - query_starts_at <= interval '3660 days'
        )
      )
  ), overlap_flags AS (
    SELECT
      candidate.craftsman_profile_id,
      guard.starts_at,
      guard.filter_available,
      COALESCE(bool_or(marking.availability = 'AVAILABLE'), false) AS has_available,
      COALESCE(bool_or(marking.availability = 'BUSY'), false) AS has_busy,
      COALESCE(bool_or(marking.availability = 'UNAVAILABLE'), false) AS has_unavailable
    FROM query_guard guard
    CROSS JOIN public.current_searchable_craftsman_profiles candidate
    LEFT JOIN public.current_craftsman_availability_blocks marking
      ON marking.craftsman_profile_id = candidate.craftsman_profile_id
      AND marking.state = 'ACTIVE'
      AND guard.starts_at IS NOT NULL
      AND marking.starts_at < guard.ends_at
      AND marking.ends_at > guard.starts_at
    GROUP BY
      candidate.craftsman_profile_id,
      guard.starts_at,
      guard.filter_available
  ), classified AS (
    SELECT
      flags.craftsman_profile_id,
      CASE
        WHEN flags.starts_at IS NULL
          THEN 'TIMING_NOT_SUPPLIED'::public.craftsman_availability_match_kind
        WHEN NOT flags.has_available AND NOT flags.has_busy AND NOT flags.has_unavailable
          THEN 'NO_OVERLAPPING_DECLARATION'::public.craftsman_availability_match_kind
        WHEN flags.has_available::integer
           + flags.has_busy::integer
           + flags.has_unavailable::integer > 1
          THEN 'MIXED_OVERLAP'::public.craftsman_availability_match_kind
        WHEN flags.has_available
          THEN 'AVAILABLE_OVERLAP'::public.craftsman_availability_match_kind
        WHEN flags.has_busy
          THEN 'BUSY_OVERLAP'::public.craftsman_availability_match_kind
        ELSE 'UNAVAILABLE_OVERLAP'::public.craftsman_availability_match_kind
      END AS match_kind,
      flags.filter_available
    FROM overlap_flags flags
  )
  SELECT
    classified.craftsman_profile_id,
    classified.match_kind,
    classified.match_kind = 'AVAILABLE_OVERLAP' AS indicatively_available
  FROM classified
  WHERE NOT classified.filter_available
    OR classified.match_kind = 'AVAILABLE_OVERLAP'
  ORDER BY
    CASE classified.match_kind
      WHEN 'AVAILABLE_OVERLAP' THEN 0
      ELSE 1
    END,
    classified.craftsman_profile_id ASC;
$$;

COMMENT ON FUNCTION craftsman_availability_match_facts(
  timestamptz,
  timestamptz,
  boolean
) IS
  'Server-side categorical overlap over effectively-public ACTIVE-owner candidates. Timing is optional and neutral when omitted. AVAILABLE-only overlap is an indicative soft positive; BUSY, UNAVAILABLE, MIXED and no declaration remain neutral in ordinary search. The opt-in filter accepts only unambiguous AVAILABLE-only overlap. Exact private periods, capacity, booking state and guarantees are never exposed.';
