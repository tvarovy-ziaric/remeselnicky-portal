-- R2-001 keeps discovery as a live projection over authoritative aggregates.
-- There is no mutable search document table and therefore no refresh lag or
-- second publication authority.

CREATE FUNCTION craftsman_search_normalize_text(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT translate(
    lower(value),
    'áäčďéíĺľňóôŕšťúýž',
    'aacdeillnoorstuyz'
  );
$$;

CREATE INDEX craftsman_profiles_search_identity_document_gin
ON craftsman_profiles USING gin (
  to_tsvector(
    'simple'::regconfig,
    craftsman_search_normalize_text(
      COALESCE(nickname, '') || ' ' ||
      COALESCE(real_first_name, '') || ' ' ||
      COALESCE(real_last_name, '') || ' ' ||
      COALESCE(official_company_name, '')
    )
  )
);

CREATE VIEW current_searchable_craftsman_profiles
WITH (security_invoker = true)
AS
SELECT
  profile.id AS craftsman_profile_id,
  profile.profile_type,
  CASE
    WHEN profile.profile_type = 'COMPANY' THEN profile.official_company_name
    ELSE COALESCE(
      profile.nickname,
      profile.real_first_name || ' ' || profile.real_last_name
    )
  END AS primary_name,
  CASE
    WHEN profile.profile_type = 'INDIVIDUAL' AND profile.nickname IS NOT NULL
      THEN profile.real_first_name || ' ' || profile.real_last_name
    ELSE NULL
  END AS secondary_name,
  to_tsvector(
    'simple'::regconfig,
    craftsman_search_normalize_text(
      COALESCE(profile.nickname, '') || ' ' ||
      COALESCE(profile.real_first_name, '') || ' ' ||
      COALESCE(profile.real_last_name, '') || ' ' ||
      COALESCE(profile.official_company_name, '')
    )
  ) AS identity_search_document,
  area.base_municipality_code,
  municipality.name_sk AS base_municipality_name,
  area.normal_radius_meters,
  area.maximum_radius_meters,
  ARRAY(
    SELECT extra.municipality_code
    FROM craftsman_service_area_extra_municipalities extra
    JOIN location_municipalities extra_municipality
      ON extra_municipality.code = extra.municipality_code
    JOIN location_districts extra_district
      ON extra_district.code = extra_municipality.district_code
    JOIN location_regions extra_region
      ON extra_region.code = extra_district.region_code
    WHERE extra.service_area_revision_id = area.id
      AND extra_municipality.is_active
      AND extra_district.is_active
      AND extra_region.is_active
    ORDER BY extra.ordinal, extra.municipality_code
  ) AS extra_municipality_codes,
  profile.identity_verified_at IS NOT NULL AS identity_verified,
  profile.company_registration_verified_at IS NOT NULL
    AS company_registration_verified,
  profile.revision AS profile_revision,
  publication.revision AS publication_revision,
  area.revision AS service_area_revision
FROM current_craftsman_profile_publications publication
JOIN craftsman_profiles profile
  ON profile.id = publication.craftsman_profile_id
JOIN users owner
  ON owner.id = profile.owner_user_id
JOIN current_craftsman_service_areas area
  ON area.craftsman_profile_id = profile.id
JOIN location_municipalities municipality
  ON municipality.code = area.base_municipality_code
JOIN location_districts district
  ON district.code = municipality.district_code
JOIN location_regions region
  ON region.code = district.region_code
WHERE publication.effectively_public
  AND publication.review_state = 'APPROVED'
  AND publication.owner_visibility = 'PUBLIC'
  AND publication.moderation_state = 'ALLOWED'
  AND owner.account_state = 'ACTIVE'
  AND cardinality(publication.missing_requirements) = 0
  AND municipality.is_active
  AND district.is_active
  AND region.is_active
  AND craftsman_capability_public_text_safe(
    CASE
      WHEN profile.profile_type = 'COMPANY' THEN profile.official_company_name
      ELSE COALESCE(
        profile.nickname,
        profile.real_first_name || ' ' || profile.real_last_name
      )
    END
  )
  AND (
    profile.profile_type <> 'INDIVIDUAL'
    OR profile.nickname IS NULL
    OR craftsman_capability_public_text_safe(
      profile.real_first_name || ' ' || profile.real_last_name
    )
  );

CREATE VIEW current_searchable_craftsman_professions
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  profession.profession_code,
  taxonomy.label_sk,
  profession.declared_level,
  profession.evidence_supported_level
FROM current_searchable_craftsman_profiles searchable
JOIN current_craftsman_professions profession
  ON profession.craftsman_profile_id = searchable.craftsman_profile_id
JOIN taxonomy_professions taxonomy
  ON taxonomy.release_id = profession.taxonomy_release_id
  AND taxonomy.profession_code = profession.profession_code
WHERE profession.state = 'ACTIVE';

CREATE VIEW current_searchable_craftsman_specializations
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  specialization.specialization_code,
  taxonomy.label_sk,
  profession.profession_code,
  specialization.evidence_supported_at IS NOT NULL AS evidence_supported
FROM current_searchable_craftsman_profiles searchable
JOIN current_craftsman_specializations specialization
  ON specialization.craftsman_profile_id = searchable.craftsman_profile_id
JOIN current_craftsman_professions profession
  ON profession.id = specialization.craftsman_profession_id
  AND profession.craftsman_profile_id = searchable.craftsman_profile_id
JOIN taxonomy_specializations taxonomy
  ON taxonomy.release_id = specialization.taxonomy_release_id
  AND taxonomy.specialization_code = specialization.specialization_code
WHERE specialization.state = 'ACTIVE'
  AND profession.state = 'ACTIVE';

CREATE VIEW current_searchable_craftsman_skills
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  COALESCE(
    skill.mapped_canonical_skill_code,
    CASE WHEN skill.identity_kind = 'CANONICAL'
      THEN skill.canonical_skill_code END
  ) AS canonical_skill_code,
  COALESCE(mapped.label_sk, original.label_sk, skill.retained_custom_text)
    AS label_sk,
  ARRAY(
    SELECT profession.profession_code
    FROM current_craftsman_professions profession
    WHERE profession.id = ANY(skill.profession_ids)
      AND profession.craftsman_profile_id = searchable.craftsman_profile_id
      AND profession.state = 'ACTIVE'
    ORDER BY profession.profession_code
  ) AS profession_codes,
  skill.evidence_supported_at IS NOT NULL AS evidence_supported
FROM current_searchable_craftsman_profiles searchable
JOIN current_craftsman_skills skill
  ON skill.craftsman_profile_id = searchable.craftsman_profile_id
LEFT JOIN skill_catalog_skills original
  ON original.release_id = skill.skill_catalog_release_id
  AND original.skill_code = skill.canonical_skill_code
LEFT JOIN skill_catalog_skills mapped
  ON mapped.release_id = skill.mapped_skill_catalog_release_id
  AND mapped.skill_code = skill.mapped_canonical_skill_code
WHERE skill.state = 'ACTIVE';

CREATE VIEW current_searchable_craftsman_credentials
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  claim.credential_type_code,
  profession.profession_code,
  claim.expires_on
FROM current_searchable_craftsman_profiles searchable
JOIN credential_claims claim
  ON claim.craftsman_profile_id = searchable.craftsman_profile_id
JOIN credential_type_policies policy
  ON policy.code = claim.credential_type_code
  AND policy.active
JOIN current_craftsman_professions profession
  ON profession.id = claim.craftsman_profession_id
  AND profession.craftsman_profile_id = searchable.craftsman_profile_id
WHERE claim.state = 'APPROVED'
  AND (claim.expires_on IS NULL OR claim.expires_on >= CURRENT_DATE)
  AND profession.state = 'ACTIVE';

CREATE VIEW current_searchable_craftsman_experience
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  experience.working_since_year
FROM current_searchable_craftsman_profiles searchable
JOIN current_craftsman_experience experience
  ON experience.craftsman_profile_id = searchable.craftsman_profile_id;

CREATE VIEW current_searchable_craftsman_pricing
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  price.service_name,
  price.price_mode,
  price.amount_cents,
  price.currency,
  profession.profession_code
FROM current_searchable_craftsman_profiles searchable
JOIN indicative_pricing_entries price
  ON price.craftsman_profile_id = searchable.craftsman_profile_id
LEFT JOIN current_craftsman_professions profession
  ON profession.id = price.craftsman_profession_id
  AND profession.craftsman_profile_id = searchable.craftsman_profile_id
  AND profession.state = 'ACTIVE'
WHERE price.state = 'ACTIVE'
  AND (
    price.craftsman_profession_id IS NULL
    OR profession.id IS NOT NULL
  );

-- Availability is private. This hook exposes only whether a current explicit
-- declaration exists; timing filters must use a separately privacy-reviewed
-- server-side intersection and must remain indicative rather than bookable.
CREATE VIEW current_searchable_craftsman_availability_signals
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  EXISTS (
    SELECT 1
    FROM current_craftsman_availability_blocks availability
    WHERE availability.craftsman_profile_id = searchable.craftsman_profile_id
      AND availability.state = 'ACTIVE'
  ) AS has_declared_availability
FROM current_searchable_craftsman_profiles searchable;

-- Only aggregate, content-free portfolio evidence hooks enter discovery.
-- One already-public representative media id is allowed; project text,
-- storage data and photo counts stay outside.
CREATE VIEW current_searchable_craftsman_portfolio_signals
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  EXISTS (
    SELECT 1 FROM current_public_portfolio_projects public_project
    WHERE public_project.craftsman_profile_id = searchable.craftsman_profile_id
      AND public_project.evidence_status = 'VERIFIED'
  ) AS has_verified_evidence,
  EXISTS (
    SELECT 1 FROM current_public_portfolio_projects public_project
    WHERE public_project.craftsman_profile_id = searchable.craftsman_profile_id
      AND public_project.evidence_status = 'UNVERIFIED'
  ) AS has_unverified_content,
  ARRAY(
    SELECT DISTINCT profession.profession_code
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project
      ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_professions profession
      ON profession.id = ANY(project.profession_ids)
      AND profession.state = 'ACTIVE'
    WHERE public_project.craftsman_profile_id = searchable.craftsman_profile_id
    ORDER BY profession.profession_code
  ) AS profession_codes,
  ARRAY(
    SELECT DISTINCT specialization.specialization_code
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project
      ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_specializations specialization
      ON specialization.id = ANY(project.specialization_ids)
      AND specialization.state = 'ACTIVE'
    WHERE public_project.craftsman_profile_id = searchable.craftsman_profile_id
    ORDER BY specialization.specialization_code
  ) AS specialization_codes,
  ARRAY(
    SELECT DISTINCT COALESCE(
      skill.mapped_canonical_skill_code,
      CASE WHEN skill.identity_kind = 'CANONICAL'
        THEN skill.canonical_skill_code END
    )
    FROM current_public_portfolio_projects public_project
    JOIN portfolio_projects project
      ON project.id = public_project.portfolio_project_id
    JOIN current_craftsman_skills skill
      ON skill.id = ANY(project.skill_ids)
      AND skill.state = 'ACTIVE'
    WHERE public_project.craftsman_profile_id = searchable.craftsman_profile_id
      AND COALESCE(
        skill.mapped_canonical_skill_code,
        CASE WHEN skill.identity_kind = 'CANONICAL'
          THEN skill.canonical_skill_code END
      ) IS NOT NULL
    ORDER BY COALESCE(
      skill.mapped_canonical_skill_code,
      CASE WHEN skill.identity_kind = 'CANONICAL'
        THEN skill.canonical_skill_code END
    )
  ) AS skill_codes,
  representative.media_asset_id AS representative_media_asset_id
FROM current_searchable_craftsman_profiles searchable
LEFT JOIN LATERAL (
  SELECT photo.media_asset_id
  FROM current_public_portfolio_project_photos photo
  LEFT JOIN current_featured_project_candidates featured
    ON featured.craftsman_profile_id = photo.craftsman_profile_id
    AND featured.portfolio_project_id = photo.portfolio_project_id
  WHERE photo.craftsman_profile_id = searchable.craftsman_profile_id
  ORDER BY
    CASE WHEN featured.portfolio_project_id IS NULL THEN 1 ELSE 0 END,
    featured.position NULLS LAST,
    photo.portfolio_project_id,
    photo.display_order,
    photo.media_asset_id
  LIMIT 1
) representative ON true;

-- R1 has no customer-rating or verified-job authority yet. Explicit neutral
-- values prevent missing history from becoming a negative search signal.
CREATE VIEW current_searchable_craftsman_trust_signals
WITH (security_invoker = true)
AS
SELECT
  searchable.craftsman_profile_id,
  NULL::numeric AS customer_score,
  0::integer AS review_count,
  false AS review_sample_sufficient,
  0::integer AS verified_work_count
FROM current_searchable_craftsman_profiles searchable;

COMMENT ON VIEW current_searchable_craftsman_profiles IS
  'One current fail-closed discovery candidate per effectively-public ACTIVE-owner profile. Public-safe coarse service preference only; no owner id, contact, exact coordinate, address, storage or customer data.';
COMMENT ON VIEW current_searchable_craftsman_professions IS
  'Current searchable profession facts. Self-declared and evidence-supported proficiency stay separate and neither is a standalone rank.';
COMMENT ON VIEW current_searchable_craftsman_specializations IS
  'Current searchable specialization facts with a separate evidence marker.';
COMMENT ON VIEW current_searchable_craftsman_skills IS
  'Current searchable skill facts with no skill-count score and a separate evidence marker.';
COMMENT ON VIEW current_searchable_craftsman_credentials IS
  'Only current admin-approved, nonexpired credential type hooks; no claims, documents, reviewer data or evidence identifiers.';
COMMENT ON VIEW current_searchable_craftsman_experience IS
  'Optional profile-wide self-declared working-since fact for alternate experience ordering; it is not verified evidence.';
COMMENT ON VIEW current_searchable_craftsman_pricing IS
  'Current active indicative EUR price rows for contextual display/filtering only; price is not a strong organic-rank signal.';
COMMENT ON VIEW current_searchable_craftsman_availability_signals IS
  'Content-free private-calendar presence hook. It is not a booking, capacity, precedence or contractual availability promise.';
COMMENT ON VIEW current_searchable_craftsman_portfolio_signals IS
  'Content-free current public portfolio relevance/provenance hook plus one exact-public-intersection representative media id. Photo quantity, storage data and project text are absent; having an image is not a rank boost.';
COMMENT ON VIEW current_searchable_craftsman_trust_signals IS
  'Cold-start-neutral trust hook. Missing history is never negative; later ratings require sufficient-sample confidence.';
