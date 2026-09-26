export const ALPHA_KPI_DEFINITION_VERSION = "D28_ALPHA_V1" as const;

export type AlphaAnalyticsTrafficClass = "REAL" | "INTERNAL" | "TEST";
export type AlphaResultCountBucket = "ZERO" | "ONE_TO_FOUR" | "FIVE_PLUS";

export interface AlphaRequestJourneyFact {
  readonly request_id: string;
  readonly traffic_class: AlphaAnalyticsTrafficClass;
  readonly submitted_at: string;
  readonly profession_code: string;
  readonly region_code?: string;
  readonly first_engaged_at?: string;
  readonly first_quote_at?: string;
  readonly quote_count: number;
  readonly job_id?: string;
  readonly confirmed_at?: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly reviewed_at?: string;
  readonly invitation_count: number;
  readonly completion_attempt_count: number;
  readonly change_order_count: number;
  readonly dispute_count: number;
  readonly report_count: number;
}

export interface AlphaSearchLiquidityFact {
  readonly search_id: string;
  readonly traffic_class: AlphaAnalyticsTrafficClass;
  readonly occurred_at: string;
  readonly profession_code: string;
  readonly region_code?: string;
  readonly result_count_bucket: AlphaResultCountBucket;
  readonly profile_opened: boolean;
  readonly candidate_count: number;
}

export interface AlphaSupplyFact {
  readonly craftsman_profile_id: string;
  readonly traffic_class: AlphaAnalyticsTrafficClass;
  readonly profession_code: string;
  readonly region_code?: string;
  readonly invitation_count: number;
  readonly engaged_count: number;
  readonly quote_count: number;
  readonly won_job_count: number;
  readonly completed_job_count: number;
}

export interface AlphaKpiDefinition {
  readonly dashboard:
    | "CORE_FUNNEL"
    | "QUALITY_PROCESS"
    | "REVIEW"
    | "SEARCH_LIQUIDITY"
    | "SPEED"
    | "SUPPLY";
  readonly description: string;
  readonly denominator: string;
  readonly formula: string;
  readonly id: AlphaKpiId;
  readonly unit: "COUNT" | "HOURS" | "RATIO";
  readonly version: typeof ALPHA_KPI_DEFINITION_VERSION;
}

export type AlphaKpiId =
  | "requests_submitted"
  | "requests_with_engagement_rate"
  | "requests_with_quote_rate"
  | "requests_confirmed_rate"
  | "confirmed_jobs_completed_rate"
  | "completed_jobs_reviewed_rate"
  | "public_approved_craftsmen"
  | "invitation_response_rate"
  | "quotes_per_engaged_provider"
  | "wins_per_quote"
  | "searches"
  | "zero_result_search_rate"
  | "search_profile_open_rate"
  | "mean_candidates_per_search"
  | "median_request_to_engagement_hours"
  | "median_request_to_quote_hours"
  | "median_quote_to_confirmation_hours"
  | "median_confirmation_to_start_hours"
  | "median_start_to_completion_hours"
  | "completion_attempts_per_completed_job"
  | "change_order_job_rate"
  | "dispute_job_rate"
  | "report_job_rate"
  | "completion_to_review_rate";

export interface AlphaMetric {
  readonly definition_id: AlphaKpiId;
  readonly denominator: number | null;
  readonly numerator: number | null;
  readonly value: number | null;
}

export interface AlphaAnalyticsDashboard {
  readonly definition_version: typeof ALPHA_KPI_DEFINITION_VERSION;
  readonly generated_at: string;
  readonly core_funnel: readonly AlphaMetric[];
  readonly supply: readonly AlphaMetric[];
  readonly search_liquidity: readonly AlphaMetric[];
  readonly speed: readonly AlphaMetric[];
  readonly quality_process: readonly AlphaMetric[];
  readonly review: readonly AlphaMetric[];
}

export const alphaKpiCatalog: Readonly<Record<AlphaKpiId, AlphaKpiDefinition>> =
  Object.freeze({
    requests_submitted: countDefinition(
      "CORE_FUNNEL",
      "Unique submitted JobRequests in the reporting cohort.",
      "Count distinct request_id.",
    ),
    requests_with_engagement_rate: rateDefinition(
      "CORE_FUNNEL",
      "Submitted requests reaching at least one ENGAGED invitation.",
      "Unique submitted JobRequests.",
      "Requests with first_engaged_at / submitted requests.",
    ),
    requests_with_quote_rate: rateDefinition(
      "CORE_FUNNEL",
      "Submitted requests receiving at least one submitted Quote.",
      "Unique submitted JobRequests.",
      "Requests with first_quote_at / submitted requests.",
    ),
    requests_confirmed_rate: rateDefinition(
      "CORE_FUNNEL",
      "Submitted requests producing one confirmed Job.",
      "Unique submitted JobRequests.",
      "Requests with confirmed_at and job_id / submitted requests.",
    ),
    confirmed_jobs_completed_rate: rateDefinition(
      "CORE_FUNNEL",
      "Confirmed Jobs reaching authoritative completion.",
      "Unique confirmed job_id.",
      "Unique completed job_id / unique confirmed job_id.",
    ),
    completed_jobs_reviewed_rate: rateDefinition(
      "CORE_FUNNEL",
      "Completed Jobs receiving at least one verified main review.",
      "Unique completed job_id.",
      "Unique reviewed completed job_id / unique completed job_id.",
    ),
    public_approved_craftsmen: countDefinition(
      "SUPPLY",
      "Unique public and approved CraftsmanProfiles in the snapshot.",
      "Count distinct craftsman_profile_id.",
    ),
    invitation_response_rate: rateDefinition(
      "SUPPLY",
      "ENGAGED provider responses among sent invitations.",
      "Sent invitations in the reporting cohort.",
      "Engaged invitations / sent invitations.",
    ),
    quotes_per_engaged_provider: rateDefinition(
      "SUPPLY",
      "Submitted Quotes per provider engagement.",
      "Engaged provider responses.",
      "Submitted Quotes / engaged responses.",
    ),
    wins_per_quote: rateDefinition(
      "SUPPLY",
      "Won Jobs among submitted Quotes.",
      "Submitted Quotes.",
      "Won Jobs / submitted Quotes.",
    ),
    searches: countDefinition(
      "SEARCH_LIQUIDITY",
      "Unique completed authoritative searches.",
      "Count distinct search_id.",
    ),
    zero_result_search_rate: rateDefinition(
      "SEARCH_LIQUIDITY",
      "Searches with no eligible result.",
      "Unique completed searches.",
      "ZERO result searches / completed searches.",
    ),
    search_profile_open_rate: rateDefinition(
      "SEARCH_LIQUIDITY",
      "Searches producing at least one actual result-profile open.",
      "Unique completed searches.",
      "Searches with profile_opened / completed searches.",
    ),
    mean_candidates_per_search: rateDefinition(
      "SEARCH_LIQUIDITY",
      "Mean privacy-safe candidate count per completed search.",
      "Unique completed searches.",
      "Sum candidate_count / completed searches.",
    ),
    median_request_to_engagement_hours: hoursDefinition(
      "Request submission to first ENGAGED provider.",
      "Requests with first_engaged_at.",
    ),
    median_request_to_quote_hours: hoursDefinition(
      "Request submission to first submitted Quote.",
      "Requests with first_quote_at.",
    ),
    median_quote_to_confirmation_hours: hoursDefinition(
      "First submitted Quote to Job confirmation.",
      "Confirmed requests with first_quote_at.",
    ),
    median_confirmation_to_start_hours: hoursDefinition(
      "Job confirmation to actual start.",
      "Jobs with started_at.",
    ),
    median_start_to_completion_hours: hoursDefinition(
      "Actual Job start to authoritative completion.",
      "Completed Jobs with started_at.",
    ),
    completion_attempts_per_completed_job: rateDefinition(
      "QUALITY_PROCESS",
      "Completion attempts per completed Job; descriptive only.",
      "Unique completed Jobs.",
      "Completion attempts / completed Jobs.",
    ),
    change_order_job_rate: jobProcessRate(
      "Jobs with at least one Change order.",
      "Confirmed Jobs with change_order_count > 0 / confirmed Jobs.",
    ),
    dispute_job_rate: jobProcessRate(
      "Jobs with at least one dispute; never a ranking signal.",
      "Confirmed Jobs with dispute_count > 0 / confirmed Jobs.",
    ),
    report_job_rate: jobProcessRate(
      "Jobs with at least one report; never a ranking signal.",
      "Confirmed Jobs with report_count > 0 / confirmed Jobs.",
    ),
    completion_to_review_rate: rateDefinition(
      "REVIEW",
      "Completed Jobs receiving at least one verified main review.",
      "Unique completed Jobs.",
      "Reviewed completed Jobs / completed Jobs.",
    ),
  });

export function buildAlphaAnalyticsDashboard(input: Readonly<{
  generated_at: string;
  requests: readonly AlphaRequestJourneyFact[];
  searches: readonly AlphaSearchLiquidityFact[];
  supply: readonly AlphaSupplyFact[];
}>): AlphaAnalyticsDashboard {
  assertTimestamp(input.generated_at, "generated_at");
  const requests = uniqueRealFacts(input.requests, "request_id");
  const searches = uniqueRealFacts(input.searches, "search_id");
  const supply = uniqueRealFacts(input.supply, "craftsman_profile_id");
  requests.forEach(assertRequestFact);
  searches.forEach(assertSearchFact);
  supply.forEach(assertSupplyFact);

  const submitted = requests.length;
  const engaged = count(requests, (fact) => fact.first_engaged_at !== undefined);
  const quoted = count(requests, (fact) => fact.first_quote_at !== undefined);
  const confirmed = requests.filter(hasConfirmedJob);
  const completed = confirmed.filter((fact) => fact.completed_at !== undefined);
  const reviewed = completed.filter((fact) => fact.reviewed_at !== undefined);
  const invitationCount = sum(supply, (fact) => fact.invitation_count);
  const engagedCount = sum(supply, (fact) => fact.engaged_count);
  const quoteCount = sum(supply, (fact) => fact.quote_count);
  const winCount = sum(supply, (fact) => fact.won_job_count);

  return Object.freeze({
    definition_version: ALPHA_KPI_DEFINITION_VERSION,
    generated_at: input.generated_at,
    core_funnel: Object.freeze([
      metric("requests_submitted", submitted, null, submitted),
      ratio("requests_with_engagement_rate", engaged, submitted),
      ratio("requests_with_quote_rate", quoted, submitted),
      ratio("requests_confirmed_rate", confirmed.length, submitted),
      ratio("confirmed_jobs_completed_rate", completed.length, confirmed.length),
      ratio("completed_jobs_reviewed_rate", reviewed.length, completed.length),
    ]),
    supply: Object.freeze([
      metric("public_approved_craftsmen", supply.length, null, supply.length),
      ratio("invitation_response_rate", engagedCount, invitationCount),
      ratio("quotes_per_engaged_provider", quoteCount, engagedCount),
      ratio("wins_per_quote", winCount, quoteCount),
    ]),
    search_liquidity: Object.freeze([
      metric("searches", searches.length, null, searches.length),
      ratio(
        "zero_result_search_rate",
        count(searches, (fact) => fact.result_count_bucket === "ZERO"),
        searches.length,
      ),
      ratio(
        "search_profile_open_rate",
        count(searches, (fact) => fact.profile_opened),
        searches.length,
      ),
      ratio(
        "mean_candidates_per_search",
        sum(searches, (fact) => fact.candidate_count),
        searches.length,
      ),
    ]),
    speed: Object.freeze([
      medianDurationMetric(
        "median_request_to_engagement_hours",
        requests,
        (fact) => durationHours(fact.submitted_at, fact.first_engaged_at),
      ),
      medianDurationMetric(
        "median_request_to_quote_hours",
        requests,
        (fact) => durationHours(fact.submitted_at, fact.first_quote_at),
      ),
      medianDurationMetric(
        "median_quote_to_confirmation_hours",
        requests,
        (fact) => durationHours(fact.first_quote_at, fact.confirmed_at),
      ),
      medianDurationMetric(
        "median_confirmation_to_start_hours",
        requests,
        (fact) => durationHours(fact.confirmed_at, fact.started_at),
      ),
      medianDurationMetric(
        "median_start_to_completion_hours",
        requests,
        (fact) => durationHours(fact.started_at, fact.completed_at),
      ),
    ]),
    quality_process: Object.freeze([
      ratio(
        "completion_attempts_per_completed_job",
        sum(completed, (fact) => fact.completion_attempt_count),
        completed.length,
      ),
      ratio(
        "change_order_job_rate",
        count(confirmed, (fact) => fact.change_order_count > 0),
        confirmed.length,
      ),
      ratio(
        "dispute_job_rate",
        count(confirmed, (fact) => fact.dispute_count > 0),
        confirmed.length,
      ),
      ratio(
        "report_job_rate",
        count(confirmed, (fact) => fact.report_count > 0),
        confirmed.length,
      ),
    ]),
    review: Object.freeze([
      ratio("completion_to_review_rate", reviewed.length, completed.length),
    ]),
  });
}

export function segmentMayBePublished(
  uniqueEntityCount: number,
  minimumCohortSize = 5,
): boolean {
  return (
    Number.isSafeInteger(uniqueEntityCount) &&
    Number.isSafeInteger(minimumCohortSize) &&
    minimumCohortSize >= 2 &&
    uniqueEntityCount >= minimumCohortSize
  );
}

function countDefinition(
  dashboard: AlphaKpiDefinition["dashboard"],
  description: string,
  formula: string,
): AlphaKpiDefinition {
  return definition(dashboard, description, "Not applicable.", formula, "COUNT");
}

function rateDefinition(
  dashboard: AlphaKpiDefinition["dashboard"],
  description: string,
  denominator: string,
  formula: string,
): AlphaKpiDefinition {
  return definition(dashboard, description, denominator, formula, "RATIO");
}

function hoursDefinition(
  description: string,
  denominator: string,
): AlphaKpiDefinition {
  return definition(
    "SPEED",
    description,
    denominator,
    "Median of non-negative server-time duration in hours.",
    "HOURS",
  );
}

function jobProcessRate(
  description: string,
  formula: string,
): AlphaKpiDefinition {
  return rateDefinition(
    "QUALITY_PROCESS",
    description,
    "Unique confirmed Jobs.",
    formula,
  );
}

function definition(
  dashboard: AlphaKpiDefinition["dashboard"],
  description: string,
  denominator: string,
  formula: string,
  unit: AlphaKpiDefinition["unit"],
): AlphaKpiDefinition {
  return {
    dashboard,
    description,
    denominator,
    formula,
    id: "requests_submitted",
    unit,
    version: ALPHA_KPI_DEFINITION_VERSION,
  };
}

// Helpers avoid repeating IDs; normalize each definition from its catalog key.
for (const [id, value] of Object.entries(alphaKpiCatalog)) {
  (value as { id: AlphaKpiId }).id = id as AlphaKpiId;
}

function uniqueRealFacts<T extends { readonly traffic_class: AlphaAnalyticsTrafficClass }>(
  facts: readonly T[],
  key: keyof T,
): T[] {
  const unique = new Map<string, T>();
  for (const fact of facts) {
    if (fact.traffic_class !== "REAL") continue;
    const value = fact[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${String(key)} must be a non-empty opaque identifier`);
    }
    if (unique.has(value)) {
      throw new TypeError(`duplicate ${String(key)} analytics fact`);
    }
    unique.set(value, fact);
  }
  return [...unique.values()];
}

function assertRequestFact(fact: AlphaRequestJourneyFact): void {
  assertExactFactKeys(fact, [
    "request_id", "traffic_class", "submitted_at", "profession_code",
    "region_code", "first_engaged_at", "first_quote_at", "quote_count",
    "job_id", "confirmed_at", "started_at", "completed_at", "reviewed_at",
    "invitation_count", "completion_attempt_count", "change_order_count",
    "dispute_count", "report_count",
  ]);
  assertTimestamp(fact.submitted_at, "submitted_at");
  assertMachineCode(fact.profession_code, "profession_code");
  assertOptionalMachineCode(fact.region_code, "region_code");
  const sequence = [
    fact.submitted_at,
    fact.first_engaged_at,
    fact.first_quote_at,
    fact.confirmed_at,
    fact.started_at,
    fact.completed_at,
    fact.reviewed_at,
  ];
  for (const value of sequence) if (value !== undefined) assertTimestamp(value, "journey timestamp");
  for (let index = 1; index < sequence.length; index += 1) {
    const current = sequence[index];
    if (current === undefined) continue;
    const prior = sequence.slice(0, index).filter((value): value is string => value !== undefined).at(-1);
    if (prior !== undefined && Date.parse(current) < Date.parse(prior)) {
      throw new TypeError("request journey timestamps must be monotonic");
    }
  }
  if ((fact.job_id === undefined) !== (fact.confirmed_at === undefined)) {
    throw new TypeError("confirmed request requires both job_id and confirmed_at");
  }
  if (fact.first_quote_at === undefined && fact.quote_count !== 0) {
    throw new TypeError("quote_count requires first_quote_at");
  }
  assertCounters(fact, [
    "quote_count",
    "invitation_count",
    "completion_attempt_count",
    "change_order_count",
    "dispute_count",
    "report_count",
  ]);
}

function assertSearchFact(fact: AlphaSearchLiquidityFact): void {
  assertExactFactKeys(fact, [
    "search_id", "traffic_class", "occurred_at", "profession_code",
    "region_code", "result_count_bucket", "profile_opened", "candidate_count",
  ]);
  assertTimestamp(fact.occurred_at, "occurred_at");
  assertMachineCode(fact.profession_code, "profession_code");
  assertOptionalMachineCode(fact.region_code, "region_code");
  assertCounter(fact.candidate_count, "candidate_count");
  if (fact.result_count_bucket === "ZERO" && fact.candidate_count !== 0) {
    throw new TypeError("zero-result search must have zero candidates");
  }
}

function assertSupplyFact(fact: AlphaSupplyFact): void {
  assertExactFactKeys(fact, [
    "craftsman_profile_id", "traffic_class", "profession_code", "region_code",
    "invitation_count", "engaged_count", "quote_count", "won_job_count",
    "completed_job_count",
  ]);
  assertMachineCode(fact.profession_code, "profession_code");
  assertOptionalMachineCode(fact.region_code, "region_code");
  assertCounters(fact, [
    "invitation_count",
    "engaged_count",
    "quote_count",
    "won_job_count",
    "completed_job_count",
  ]);
}

function assertExactFactKeys(
  fact: object,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(fact).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`unknown analytics fact property: ${unknown}`);
  }
}

function assertCounters<T extends object>(fact: T, keys: readonly (keyof T)[]): void {
  for (const key of keys) assertCounter(fact[key], String(key));
}

function assertCounter(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertTimestamp(value: string, name: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
}

function assertMachineCode(value: string, name: string): void {
  if (!/^[A-Z0-9][A-Z0-9._:-]{1,63}$/u.test(value)) {
    throw new TypeError(`${name} must be a bounded machine code`);
  }
}

function assertOptionalMachineCode(value: string | undefined, name: string): void {
  if (value !== undefined) assertMachineCode(value, name);
}

function hasConfirmedJob(
  fact: AlphaRequestJourneyFact,
): fact is AlphaRequestJourneyFact & { readonly job_id: string; readonly confirmed_at: string } {
  return fact.job_id !== undefined && fact.confirmed_at !== undefined;
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function ratio(id: AlphaKpiId, numerator: number, denominator: number): AlphaMetric {
  return metric(id, numerator, denominator, denominator === 0 ? null : numerator / denominator);
}

function metric(
  definition_id: AlphaKpiId,
  numerator: number | null,
  denominator: number | null,
  value: number | null,
): AlphaMetric {
  return Object.freeze({ definition_id, denominator, numerator, value });
}

function durationHours(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  return (Date.parse(end) - Date.parse(start)) / 3_600_000;
}

function medianDurationMetric<T>(
  id: AlphaKpiId,
  facts: readonly T[],
  select: (fact: T) => number | undefined,
): AlphaMetric {
  const durations = facts
    .map(select)
    .filter((value): value is number => value !== undefined && value >= 0)
    .sort((left, right) => left - right);
  if (durations.length === 0) return metric(id, null, 0, null);
  const middle = Math.floor(durations.length / 2);
  const right = durations[middle];
  if (right === undefined) return metric(id, null, 0, null);
  const value =
    durations.length % 2 === 1
      ? right
      : ((durations[middle - 1] ?? right) + right) / 2;
  return metric(id, null, durations.length, value);
}
