-- R2-004 classifies live R2-001 candidates using the internal distance facts
-- from R2-003. Radius remains a preference, never a contractual acceptance,
-- booking, availability or travel-fee promise.

CREATE TYPE craftsman_service_area_match_kind AS ENUM (
  'ADDITIONAL_SERVICE_AREA',
  'WITHIN_NORMAL_RADIUS',
  'WITHIN_MAXIMUM_RADIUS',
  'OUTSIDE_DECLARED_AREA',
  'DISTANCE_UNAVAILABLE'
);

CREATE FUNCTION craftsman_service_area_match_facts(
  query_municipality_code text,
  include_outside_declared_area boolean
)
RETURNS TABLE (
  craftsman_profile_id uuid,
  match_kind craftsman_service_area_match_kind,
  ranking_distance_meters integer,
  approximate_distance_km integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH classified AS (
    SELECT
      candidate.craftsman_profile_id,
      CASE
        WHEN query_municipality_code IS NULL
          THEN 'DISTANCE_UNAVAILABLE'::public.craftsman_service_area_match_kind
        WHEN query_municipality_code = ANY(candidate.extra_municipality_codes)
          THEN 'ADDITIONAL_SERVICE_AREA'::public.craftsman_service_area_match_kind
        WHEN distance.ranking_distance_meters <= candidate.normal_radius_meters
          THEN 'WITHIN_NORMAL_RADIUS'::public.craftsman_service_area_match_kind
        WHEN candidate.maximum_radius_meters IS NOT NULL
          AND distance.ranking_distance_meters <= candidate.maximum_radius_meters
          THEN 'WITHIN_MAXIMUM_RADIUS'::public.craftsman_service_area_match_kind
        ELSE 'OUTSIDE_DECLARED_AREA'::public.craftsman_service_area_match_kind
      END AS match_kind,
      distance.ranking_distance_meters,
      distance.approximate_distance_km
    FROM public.current_searchable_craftsman_profiles candidate
    JOIN public.public_craftsman_distance_facts(query_municipality_code) distance
      ON distance.craftsman_profile_id = candidate.craftsman_profile_id
  )
  SELECT
    classified.craftsman_profile_id,
    classified.match_kind,
    classified.ranking_distance_meters,
    classified.approximate_distance_km
  FROM classified
  WHERE classified.match_kind <> 'OUTSIDE_DECLARED_AREA'
    OR COALESCE(include_outside_declared_area, false)
  ORDER BY
    CASE classified.match_kind
      WHEN 'ADDITIONAL_SERVICE_AREA' THEN 0
      WHEN 'WITHIN_NORMAL_RADIUS' THEN 0
      WHEN 'WITHIN_MAXIMUM_RADIUS' THEN 1
      WHEN 'OUTSIDE_DECLARED_AREA' THEN 2
      WHEN 'DISTANCE_UNAVAILABLE' THEN 0
    END,
    classified.ranking_distance_meters ASC NULLS LAST,
    classified.craftsman_profile_id ASC;
$$;

COMMENT ON FUNCTION craftsman_service_area_match_facts(text, boolean) IS
  'Server-only live service-preference match facts over effectively-public ACTIVE-owner profiles. Maximum radius is farther-by-agreement and remains default-eligible below normal matches; clearly outside requires explicit broadening. Null origin is neutral. Metre precision is internal and no band promises acceptance, availability or a travel price.';
