/**
 * Stable SQL-view seam for R2 discovery consumers. These names describe live
 * views created by migration 0029; mutable source tables remain authoritative.
 */
export const CRAFTSMAN_SEARCH_READ_MODEL_VIEWS = Object.freeze({
  profiles: "current_searchable_craftsman_profiles",
  professions: "current_searchable_craftsman_professions",
  specializations: "current_searchable_craftsman_specializations",
  skills: "current_searchable_craftsman_skills",
  credentials: "current_searchable_craftsman_credentials",
  experience: "current_searchable_craftsman_experience",
  pricing: "current_searchable_craftsman_pricing",
  availabilitySignals: "current_searchable_craftsman_availability_signals",
  portfolioSignals: "current_searchable_craftsman_portfolio_signals",
  trustSignals: "current_searchable_craftsman_trust_signals",
} as const);

/** Privacy-reviewed columns on the one-row-per-profile base view. */
export const SEARCHABLE_CRAFTSMAN_PROFILE_COLUMNS = Object.freeze([
  "craftsman_profile_id",
  "profile_type",
  "primary_name",
  "secondary_name",
  "identity_search_document",
  "base_municipality_code",
  "base_municipality_name",
  "normal_radius_meters",
  "maximum_radius_meters",
  "extra_municipality_codes",
  "identity_verified",
  "company_registration_verified",
  "profile_revision",
  "publication_revision",
  "service_area_revision",
] as const);
