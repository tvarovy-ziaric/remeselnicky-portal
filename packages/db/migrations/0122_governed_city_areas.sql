-- Bratislava and Kosice are represented by their city districts in the
-- official municipality register. A governed city area is a selectable,
-- source-derived parent locality; its member municipalities remain the
-- authoritative fine-grained locations.

CREATE TABLE location_city_areas (
  municipality_code text PRIMARY KEY
    REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  member_count integer NOT NULL,
  source_reference text NOT NULL,
  source_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT location_city_areas_member_count_positive CHECK (member_count > 1),
  CONSTRAINT location_city_areas_source_safe CHECK (
    source_reference = btrim(source_reference)
    AND length(source_reference) BETWEEN 1 AND 500
    AND source_revision = btrim(source_revision)
    AND length(source_revision) BETWEEN 1 AND 120
  )
);

CREATE TABLE location_city_area_members (
  city_area_code text NOT NULL
    REFERENCES location_city_areas(municipality_code) ON DELETE RESTRICT,
  municipality_code text NOT NULL
    REFERENCES location_municipalities(code) ON DELETE RESTRICT,
  PRIMARY KEY (city_area_code, municipality_code),
  CONSTRAINT location_city_area_member_not_self CHECK (
    city_area_code <> municipality_code
  )
);

CREATE INDEX location_city_area_members_municipality_idx
  ON location_city_area_members (municipality_code, city_area_code);

CREATE FUNCTION governed_locations_overlap(
  left_location_code text,
  right_location_code text
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT left_location_code = right_location_code
    OR EXISTS (
      SELECT 1
      FROM public.location_city_area_members member
      WHERE member.city_area_code = left_location_code
        AND member.municipality_code = right_location_code
    )
    OR EXISTS (
      SELECT 1
      FROM public.location_city_area_members member
      WHERE member.city_area_code = right_location_code
        AND member.municipality_code = left_location_code
    )
    OR EXISTS (
      SELECT 1
      FROM public.location_city_area_members left_member
      JOIN public.location_city_area_members right_member
        ON right_member.municipality_code = left_member.municipality_code
      WHERE left_member.city_area_code = left_location_code
        AND right_member.city_area_code = right_location_code
    );
$$;

COMMENT ON TABLE location_city_areas IS
  'Selectable source-derived whole-city localities whose authoritative members are municipality/city-district rows.';
COMMENT ON TABLE location_city_area_members IS
  'Authoritative municipality membership used to expand a whole-city selection for service-area matching.';
COMMENT ON FUNCTION governed_locations_overlap(text, text) IS
  'True when two governed locality selections are identical or one city-area selection contains the other municipality.';


CREATE OR REPLACE FUNCTION craftsman_service_area_match_facts(
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
        WHEN EXISTS (
          SELECT 1
          FROM unnest(candidate.extra_municipality_codes) extra(code)
          WHERE public.governed_locations_overlap(
            query_municipality_code,
            extra.code
          )
        ) THEN 'ADDITIONAL_SERVICE_AREA'::public.craftsman_service_area_match_kind
        WHEN public.governed_locations_overlap(
          query_municipality_code,
          candidate.base_municipality_code
        ) THEN 'WITHIN_NORMAL_RADIUS'::public.craftsman_service_area_match_kind
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
  'Server-only service-area facts. Whole-city selections expand to governed municipality members; maximum radius is farther-by-agreement and outside-area candidates require explicit broadening.';
