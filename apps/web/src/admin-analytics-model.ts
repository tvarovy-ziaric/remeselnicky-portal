export type AlphaKpiUnit = "COUNT" | "HOURS" | "RATIO";

export interface AlphaMetricView {
  readonly definitionId: string;
  readonly denominator: number | null;
  readonly numerator: number | null;
  readonly value: number | null;
}

export interface AlphaDashboardView {
  readonly definitionVersion: "D28_ALPHA_V1";
  readonly generatedAt: string;
  readonly groups: readonly AlphaMetricGroupView[];
  readonly range: { readonly from: string; readonly to: string };
}

export interface AlphaMetricGroupView {
  readonly id: AlphaGroupId;
  readonly label: string;
  readonly metrics: readonly AlphaMetricView[];
}

export type AlphaGroupId =
  | "core_funnel"
  | "supply"
  | "search_liquidity"
  | "speed"
  | "quality_process"
  | "review";

export const ALPHA_KPI_PRESENTATION: Readonly<
  Record<string, { readonly label: string; readonly unit: AlphaKpiUnit }>
> = Object.freeze({
  requests_submitted: { label: "Odoslané dopyty", unit: "COUNT" },
  requests_with_engagement_rate: {
    label: "Dopyty s reakciou remeselníka",
    unit: "RATIO",
  },
  requests_with_quote_rate: { label: "Dopyty s ponukou", unit: "RATIO" },
  requests_confirmed_rate: { label: "Dopyty so zákazkou", unit: "RATIO" },
  confirmed_jobs_completed_rate: {
    label: "Dokončené potvrdené zákazky",
    unit: "RATIO",
  },
  completed_jobs_reviewed_rate: {
    label: "Dokončené zákazky s recenziou",
    unit: "RATIO",
  },
  public_approved_craftsmen: {
    label: "Verejní schválení remeselníci",
    unit: "COUNT",
  },
  invitation_response_rate: { label: "Reakcie na pozvánky", unit: "RATIO" },
  quotes_per_engaged_provider: {
    label: "Ponuky na reagujúceho remeselníka",
    unit: "RATIO",
  },
  wins_per_quote: { label: "Výhry na ponuku", unit: "RATIO" },
  searches: { label: "Vyhľadávania", unit: "COUNT" },
  zero_result_search_rate: {
    label: "Vyhľadávania bez výsledku",
    unit: "RATIO",
  },
  search_profile_open_rate: {
    label: "Vyhľadávania s otvorením profilu",
    unit: "RATIO",
  },
  mean_candidates_per_search: {
    label: "Priemer kandidátov na vyhľadávanie",
    unit: "RATIO",
  },
  median_request_to_engagement_hours: {
    label: "Dopyt → prvá reakcia (medián)",
    unit: "HOURS",
  },
  median_request_to_quote_hours: {
    label: "Dopyt → prvá ponuka (medián)",
    unit: "HOURS",
  },
  median_quote_to_confirmation_hours: {
    label: "Ponuka → potvrdenie (medián)",
    unit: "HOURS",
  },
  median_confirmation_to_start_hours: {
    label: "Potvrdenie → začiatok (medián)",
    unit: "HOURS",
  },
  median_start_to_completion_hours: {
    label: "Začiatok → dokončenie (medián)",
    unit: "HOURS",
  },
  p90_request_to_engagement_hours: {
    label: "Dopyt → prvá reakcia (p90)",
    unit: "HOURS",
  },
  p90_request_to_quote_hours: {
    label: "Dopyt → prvá ponuka (p90)",
    unit: "HOURS",
  },
  p90_quote_to_confirmation_hours: {
    label: "Ponuka → potvrdenie (p90)",
    unit: "HOURS",
  },
  p90_confirmation_to_start_hours: {
    label: "Potvrdenie → začiatok (p90)",
    unit: "HOURS",
  },
  p90_start_to_completion_hours: {
    label: "Začiatok → dokončenie (p90)",
    unit: "HOURS",
  },
  completion_attempts_per_completed_job: {
    label: "Pokusy o dokončenie na zákazku",
    unit: "RATIO",
  },
  change_order_job_rate: { label: "Zákazky so zmenou", unit: "RATIO" },
  dispute_job_rate: { label: "Zákazky so sporom", unit: "RATIO" },
  report_job_rate: { label: "Zákazky s hlásením", unit: "RATIO" },
  completion_to_review_rate: {
    label: "Dokončenie → recenzia",
    unit: "RATIO",
  },
});

const GROUPS: readonly { readonly id: AlphaGroupId; readonly label: string }[] =
  [
    { id: "core_funnel", label: "Hlavný lievik" },
    { id: "supply", label: "Ponuka remeselníkov" },
    { id: "search_liquidity", label: "Vyhľadávanie a likvidita" },
    { id: "speed", label: "Rýchlosť" },
    { id: "quality_process", label: "Kvalita procesu" },
    { id: "review", label: "Recenzie" },
  ];

export function parseAlphaDashboard(
  value: unknown,
): AlphaDashboardView | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["dashboard", "range"]) ||
    !isRecord(value.dashboard) ||
    !hasExactKeys(value.dashboard, [
      "definition_version",
      "generated_at",
      ...GROUPS.map(({ id }) => id),
    ]) ||
    !isRecord(value.range) ||
    !hasExactKeys(value.range, ["from", "to"])
  ) {
    return undefined;
  }
  const dashboard = value.dashboard;
  if (
    dashboard.definition_version !== "D28_ALPHA_V1" ||
    !isCanonicalTimestamp(dashboard.generated_at) ||
    !isCanonicalTimestamp(value.range.from) ||
    !isCanonicalTimestamp(value.range.to) ||
    Date.parse(value.range.from) >= Date.parse(value.range.to)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const groups: AlphaMetricGroupView[] = [];
  for (const group of GROUPS) {
    const source = dashboard[group.id];
    if (!Array.isArray(source)) return undefined;
    const metrics: AlphaMetricView[] = [];
    for (const item of source) {
      if (!isMetric(item) || seen.has(item.definition_id)) return undefined;
      seen.add(item.definition_id);
      metrics.push({
        definitionId: item.definition_id,
        denominator: item.denominator,
        numerator: item.numerator,
        value: item.value,
      });
    }
    groups.push({ ...group, metrics });
  }
  if (seen.size !== Object.keys(ALPHA_KPI_PRESENTATION).length)
    return undefined;
  return {
    definitionVersion: dashboard.definition_version,
    generatedAt: dashboard.generated_at,
    groups,
    range: { from: value.range.from, to: value.range.to },
  };
}

function isMetric(value: unknown): value is {
  readonly definition_id: string;
  readonly denominator: number | null;
  readonly numerator: number | null;
  readonly value: number | null;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "definition_id",
      "denominator",
      "numerator",
      "value",
    ]) &&
    typeof value.definition_id === "string" &&
    Object.hasOwn(ALPHA_KPI_PRESENTATION, value.definition_id) &&
    isNullableNonNegativeNumber(value.denominator) &&
    isNullableNonNegativeNumber(value.numerator) &&
    isNullableNonNegativeNumber(value.value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
