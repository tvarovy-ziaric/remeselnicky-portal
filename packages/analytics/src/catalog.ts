export const analyticsEventNames = [
  "public_profile_viewed",
  "search_started",
  "search_executed",
  "search_results_viewed",
  "craftsman_profile_opened_from_search",
  "craftsman_request_cta_clicked",
  "shortlist_added",
  "shortlist_removed",
  "registration_completed",
  "email_verification_completed",
  "phone_verification_completed",
  "job_request_submitted",
  "invitation_engaged",
  "quote_submitted",
  "quote_accepted",
  "job_confirmed",
  "job_completed",
  "review_submitted",
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];

export const SEARCH_ANALYTICS_VERSION = "R2_SEARCH_V1" as const;

export type AnalyticsPropertyKind =
  | "BOOLEAN"
  | "CTA_ORIGIN"
  | "GOVERNED_LOCATION_AREA_CODE"
  | "LOCATION_AREA_GRANULARITY"
  | "LOCATION_SCOPE"
  | "PROFESSION_CODE"
  | "RESULT_COUNT_BUCKET"
  | "RESULT_POSITION"
  | "SEARCH_AVAILABILITY_COUNT_BUCKET"
  | "SEARCH_SORT_MODE"
  | "SEARCH_VERSION"
  | "SHORTLIST_SIZE_BUCKET"
  | "SPECIALIZATION_CODE"
  | "UUID";

export type AnalyticsPropertyRule =
  | AnalyticsPropertyKind
  | Readonly<{
      kind: AnalyticsPropertyKind;
      optional: true;
    }>;

export interface AnalyticsEventDefinition {
  readonly description: string;
  readonly properties: Readonly<Record<string, AnalyticsPropertyRule>>;
  readonly schema_version: number;
  readonly source: "CLIENT_UX" | "SERVER_DOMAIN" | "SERVER_QUERY";
  readonly trigger: string;
}

/**
 * The deliberately small, feature-owned catalog rejects ad-hoc names and
 * properties. R4-027 may compose dashboards from these stable observations;
 * it must not reinterpret their documented triggers or denominators.
 */
export const analyticsEventCatalog = Object.freeze({
  public_profile_viewed: definition(
    "A public CraftsmanProfile was viewed.",
    "When an actually visible public profile view is accepted for UX analytics.",
    { craftsman_profile_id: "UUID" },
    "CLIENT_UX",
  ),
  search_started: definition(
    "A visitor explicitly started a new public craftsman search.",
    "When an explicit submit or normalized filter/sort change starts a new first-page search; never on typing or autocomplete.",
    { search_id: "UUID" },
    "CLIENT_UX",
  ),
  search_executed: definition(
    "A public craftsman search completed after all authoritative eligibility gates.",
    "On the server after the first-page search snapshot completes successfully; invalid and failed searches do not emit it.",
    {
      eligible_result_count_bucket: "RESULT_COUNT_BUCKET",
      include_outside_declared_area: "BOOLEAN",
      indicative_availability_filter: "BOOLEAN",
      indicatively_available_count_bucket: "SEARCH_AVAILABILITY_COUNT_BUCKET",
      location_area_code: optional("GOVERNED_LOCATION_AREA_CODE"),
      location_area_granularity: optional("LOCATION_AREA_GRANULARITY"),
      location_scope: "LOCATION_SCOPE",
      profession_code: "PROFESSION_CODE",
      search_id: "UUID",
      search_version: "SEARCH_VERSION",
      skill_filter_used: "BOOLEAN",
      sort_mode: "SEARCH_SORT_MODE",
      specialization_code: optional("SPECIALIZATION_CODE"),
      timing_supplied: "BOOLEAN",
    },
    "SERVER_QUERY",
  ),
  search_results_viewed: definition(
    "A public search result list or zero-result state became visible.",
    "When the first-page result state is actually visible; never on server render alone or link prefetch.",
    {
      rendered_result_count_bucket: "RESULT_COUNT_BUCKET",
      search_id: "UUID",
      search_version: "SEARCH_VERSION",
      sort_mode: "SEARCH_SORT_MODE",
    },
    "CLIENT_UX",
  ),
  craftsman_profile_opened_from_search: definition(
    "A visitor opened one craftsman profile from a visible search result.",
    "On an actual user navigation from a result card, not hover, impression or prefetch.",
    {
      craftsman_profile_id: "UUID",
      result_position: "RESULT_POSITION",
      search_id: "UUID",
      search_version: "SEARCH_VERSION",
      sort_mode: "SEARCH_SORT_MODE",
    },
    "CLIENT_UX",
  ),
  craftsman_request_cta_clicked: definition(
    "A visitor clicked the request/contact CTA for a public craftsman.",
    "On the explicit CTA interaction; this is not a submitted request or completed business conversion.",
    {
      craftsman_profile_id: "UUID",
      origin: "CTA_ORIGIN",
      search_id: optional("UUID"),
    },
    "CLIENT_UX",
  ),
  shortlist_added: definition(
    "A craftsman was added to a customer's private shortlist.",
    "After an R2-012 ADD command commits with APPLIED; never for retry, DEDUPLICATED or UNCHANGED.",
    {
      shortlist_size_bucket: "SHORTLIST_SIZE_BUCKET",
    },
  ),
  shortlist_removed: definition(
    "A craftsman was removed from a customer's private shortlist.",
    "After an R2-012 REMOVE command commits with APPLIED; never for retry, DEDUPLICATED or UNCHANGED.",
    {
      shortlist_size_bucket: "SHORTLIST_SIZE_BUCKET",
    },
  ),
  registration_completed: definition(
    "A new eligible user account was committed successfully.",
    "After the registration transaction commits.",
    {},
  ),
  email_verification_completed: definition(
    "An account email became verified.",
    "After the email-verification transaction commits.",
    {},
  ),
  phone_verification_completed: definition(
    "An account phone number became verified.",
    "After the phone-verification transaction commits.",
    {},
  ),
  job_request_submitted: definition(
    "A JobRequest entered its submitted state.",
    "After the JobRequest submission transaction commits.",
    { job_request_id: "UUID" },
  ),
  invitation_engaged: definition(
    "An invitation entered ENGAGED.",
    "After the invitation engagement transaction commits.",
    { invitation_id: "UUID", job_request_id: "UUID" },
  ),
  quote_submitted: definition(
    "A Quote revision was submitted.",
    "After the Quote submission transaction commits.",
    { job_request_id: "UUID", quote_id: "UUID" },
  ),
  quote_accepted: definition(
    "A Quote was accepted through the successful acceptance command.",
    "After the atomic Quote acceptance and Job creation transaction commits.",
    { job_id: "UUID", job_request_id: "UUID", quote_id: "UUID" },
  ),
  job_confirmed: definition(
    "A confirmed Job was created from an accepted Quote.",
    "After the atomic Quote acceptance and Job creation transaction commits.",
    { job_id: "UUID", job_request_id: "UUID", quote_id: "UUID" },
  ),
  job_completed: definition(
    "A Job reached its final COMPLETED state.",
    "After the completion transaction commits.",
    { job_id: "UUID" },
  ),
  review_submitted: definition(
    "An eligible verified-Job review was submitted.",
    "After the review submission transaction commits.",
    { job_id: "UUID", review_id: "UUID" },
  ),
} satisfies Readonly<Record<AnalyticsEventName, AnalyticsEventDefinition>>);

export type AnalyticsPropertiesByName = {
  readonly public_profile_viewed: Readonly<{
    craftsman_profile_id: string;
  }>;
  readonly search_started: Readonly<{ search_id: string }>;
  readonly search_executed: Readonly<{
    eligible_result_count_bucket: AnalyticsResultCountBucket;
    include_outside_declared_area: boolean;
    indicative_availability_filter: boolean;
    indicatively_available_count_bucket: AnalyticsAvailabilityCountBucket;
    location_area_code?: string;
    location_area_granularity?: AnalyticsLocationAreaGranularity;
    location_scope: AnalyticsLocationScope;
    profession_code: string;
    search_id: string;
    search_version: typeof SEARCH_ANALYTICS_VERSION;
    skill_filter_used: boolean;
    sort_mode: AnalyticsSearchSortMode;
    specialization_code?: string;
    timing_supplied: boolean;
  }>;
  readonly search_results_viewed: Readonly<{
    rendered_result_count_bucket: AnalyticsResultCountBucket;
    search_id: string;
    search_version: typeof SEARCH_ANALYTICS_VERSION;
    sort_mode: AnalyticsSearchSortMode;
  }>;
  readonly craftsman_profile_opened_from_search: Readonly<{
    craftsman_profile_id: string;
    result_position: number;
    search_id: string;
    search_version: typeof SEARCH_ANALYTICS_VERSION;
    sort_mode: AnalyticsSearchSortMode;
  }>;
  readonly craftsman_request_cta_clicked: Readonly<{
    craftsman_profile_id: string;
    origin: AnalyticsCtaOrigin;
    search_id?: string;
  }>;
  readonly shortlist_added: Readonly<{
    shortlist_size_bucket: AnalyticsShortlistSizeBucket;
  }>;
  readonly shortlist_removed: Readonly<{
    shortlist_size_bucket: AnalyticsShortlistSizeBucket;
  }>;
  readonly registration_completed: Readonly<Record<string, never>>;
  readonly email_verification_completed: Readonly<Record<string, never>>;
  readonly phone_verification_completed: Readonly<Record<string, never>>;
  readonly job_request_submitted: Readonly<{ job_request_id: string }>;
  readonly invitation_engaged: Readonly<{
    invitation_id: string;
    job_request_id: string;
  }>;
  readonly quote_submitted: Readonly<{
    job_request_id: string;
    quote_id: string;
  }>;
  readonly quote_accepted: Readonly<{
    job_id: string;
    job_request_id: string;
    quote_id: string;
  }>;
  readonly job_confirmed: Readonly<{
    job_id: string;
    job_request_id: string;
    quote_id: string;
  }>;
  readonly job_completed: Readonly<{ job_id: string }>;
  readonly review_submitted: Readonly<{
    job_id: string;
    review_id: string;
  }>;
};

export type AnalyticsResultCountBucket = "ZERO" | "ONE_TO_FOUR" | "FIVE_PLUS";
export type AnalyticsAvailabilityCountBucket =
  "NOT_APPLICABLE" | AnalyticsResultCountBucket;
export type AnalyticsLocationScope = "NONE" | "MUNICIPALITY_SELECTED";
export type AnalyticsLocationAreaGranularity = "DISTRICT" | "REGION";
export type AnalyticsSearchSortMode = "RECOMMENDED" | "NEAREST" | "BEST_RATED";
export type AnalyticsCtaOrigin = "PUBLIC_PROFILE" | "SEARCH_RESULTS";
export type AnalyticsShortlistSizeBucket =
  "ZERO" | "ONE" | "TWO_TO_FOUR" | "FIVE_TO_NINE" | "TEN_PLUS";

function definition(
  description: string,
  trigger: string,
  properties: Readonly<Record<string, AnalyticsPropertyRule>>,
  source: AnalyticsEventDefinition["source"] = "SERVER_DOMAIN",
): Readonly<AnalyticsEventDefinition> {
  return Object.freeze({
    description,
    properties: Object.freeze({ ...properties }),
    schema_version: 1,
    source,
    trigger,
  });
}

function optional(kind: AnalyticsPropertyKind): AnalyticsPropertyRule {
  return Object.freeze({ kind, optional: true as const });
}
