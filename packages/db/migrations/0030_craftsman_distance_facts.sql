-- R2-003 computes privacy-safe distance facts over R2-001's live eligible
-- candidate projection. Municipality centroids remain internal query inputs;
-- neither coordinates nor exact addresses are returned.

CREATE FUNCTION public_craftsman_distance_facts(
  query_municipality_code text
)
RETURNS TABLE (
  craftsman_profile_id uuid,
  ranking_distance_meters integer,
  approximate_distance_km integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH origin AS (
    SELECT municipality.centroid
    FROM public.location_municipalities municipality
    JOIN public.location_districts district
      ON district.code = municipality.district_code
    JOIN public.location_regions region
      ON region.code = district.region_code
    WHERE municipality.code = query_municipality_code
      AND municipality.is_active
      AND district.is_active
      AND region.is_active
  ),
  measured AS (
    SELECT
      candidate.craftsman_profile_id,
      CASE
        WHEN query_municipality_code IS NULL
          OR base.centroid IS NULL
          OR base_region.code IS NULL
          THEN NULL::integer
        ELSE LEAST(
          20040000::bigint,
          GREATEST(
            0::bigint,
            round(public.ST_Distance(base.centroid, origin.centroid))::bigint
          )
        )::integer
      END AS ranking_distance_meters
    FROM public.current_searchable_craftsman_profiles candidate
    LEFT JOIN public.current_craftsman_service_areas area
      ON area.craftsman_profile_id = candidate.craftsman_profile_id
      AND area.base_municipality_code = candidate.base_municipality_code
    LEFT JOIN public.location_municipalities base
      ON base.code = area.base_municipality_code
      AND base.is_active
    LEFT JOIN public.location_districts base_district
      ON base_district.code = base.district_code
      AND base_district.is_active
    LEFT JOIN public.location_regions base_region
      ON base_region.code = base_district.region_code
      AND base_region.is_active
    LEFT JOIN origin ON true
    WHERE query_municipality_code IS NULL OR origin.centroid IS NOT NULL
  )
  SELECT
    measured.craftsman_profile_id,
    measured.ranking_distance_meters,
    CASE
      WHEN measured.ranking_distance_meters IS NULL THEN NULL::integer
      ELSE round(measured.ranking_distance_meters / 1000.0)::integer
    END AS approximate_distance_km
  FROM measured
  ORDER BY
    measured.ranking_distance_meters ASC NULLS LAST,
    measured.craftsman_profile_id ASC;
$$;

COMMENT ON FUNCTION public_craftsman_distance_facts(text) IS
  'SECURITY INVOKER internal ranking-distance primitive over current searchable profiles. Returns rounded metres for server ranking and rounded kilometres for an explicit public serializer; never coordinates or addresses. Unknown/inactive origins return no candidate rows.';
