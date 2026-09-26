import { describe, expect, it } from "vitest";

import {
  ALPHA_KPI_DEFINITION_VERSION,
  alphaKpiCatalog,
  buildAlphaAnalyticsDashboard,
  segmentMayBePublished,
  type AlphaRequestJourneyFact,
} from "../src/index.js";

const submittedAt = "2026-09-01T08:00:00.000Z";

function requestFact(
  overrides: Partial<AlphaRequestJourneyFact> = {},
): AlphaRequestJourneyFact {
  return {
    request_id: "request-1",
    traffic_class: "REAL",
    submitted_at: submittedAt,
    profession_code: "PROF:ELECTRICIAN",
    quote_count: 0,
    invitation_count: 1,
    completion_attempt_count: 0,
    change_order_count: 0,
    dispute_count: 0,
    report_count: 0,
    ...overrides,
  };
}

function metric(
  dashboard: ReturnType<typeof buildAlphaAnalyticsDashboard>,
  id: string,
) {
  return [
    ...dashboard.core_funnel,
    ...dashboard.supply,
    ...dashboard.search_liquidity,
    ...dashboard.speed,
    ...dashboard.quality_process,
    ...dashboard.review,
  ].find((candidate) => candidate.definition_id === id);
}

describe("D28 alpha KPI catalog", () => {
  it("gives every dashboard metric an immutable version and exact denominator", () => {
    expect(Object.keys(alphaKpiCatalog)).toHaveLength(24);
    for (const [id, definition] of Object.entries(alphaKpiCatalog)) {
      expect(definition.id).toBe(id);
      expect(definition.version).toBe(ALPHA_KPI_DEFINITION_VERSION);
      expect(definition.denominator.length).toBeGreaterThan(0);
      expect(definition.formula.length).toBeGreaterThan(0);
    }
  });

  it("counts unique request and Job entities instead of raw observations", () => {
    const dashboard = buildAlphaAnalyticsDashboard({
      generated_at: "2026-09-30T00:00:00.000Z",
      requests: [
        requestFact({
          first_engaged_at: "2026-09-01T10:00:00.000Z",
          first_quote_at: "2026-09-01T14:00:00.000Z",
          quote_count: 2,
          job_id: "job-1",
          confirmed_at: "2026-09-02T08:00:00.000Z",
          started_at: "2026-09-03T08:00:00.000Z",
          completed_at: "2026-09-05T08:00:00.000Z",
          reviewed_at: "2026-09-06T08:00:00.000Z",
          completion_attempt_count: 2,
          change_order_count: 1,
        }),
        requestFact({ request_id: "request-2" }),
      ],
      searches: [],
      supply: [],
    });

    expect(metric(dashboard, "requests_submitted")?.value).toBe(2);
    expect(metric(dashboard, "requests_with_engagement_rate")?.value).toBe(0.5);
    expect(metric(dashboard, "requests_with_quote_rate")?.value).toBe(0.5);
    expect(metric(dashboard, "requests_confirmed_rate")?.value).toBe(0.5);
    expect(metric(dashboard, "confirmed_jobs_completed_rate")?.value).toBe(1);
    expect(metric(dashboard, "completed_jobs_reviewed_rate")?.value).toBe(1);
    expect(
      metric(dashboard, "completion_attempts_per_completed_job")?.value,
    ).toBe(2);
    expect(metric(dashboard, "change_order_job_rate")?.value).toBe(1);
  });

  it("excludes internal/test traffic and returns null for empty denominators", () => {
    const dashboard = buildAlphaAnalyticsDashboard({
      generated_at: "2026-09-30T00:00:00.000Z",
      requests: [
        requestFact({ request_id: "test", traffic_class: "TEST" }),
        requestFact({ request_id: "internal", traffic_class: "INTERNAL" }),
      ],
      searches: [],
      supply: [],
    });

    expect(metric(dashboard, "requests_submitted")?.value).toBe(0);
    expect(metric(dashboard, "requests_with_quote_rate")).toMatchObject({
      denominator: 0,
      numerator: 0,
      value: null,
    });
    expect(
      metric(dashboard, "median_request_to_quote_hours")?.value,
    ).toBeNull();
  });

  it("uses server-time medians and privacy-safe search/supply aggregates", () => {
    const dashboard = buildAlphaAnalyticsDashboard({
      generated_at: "2026-09-30T00:00:00.000Z",
      requests: [
        requestFact({
          request_id: "request-1",
          first_engaged_at: "2026-09-01T10:00:00.000Z",
        }),
        requestFact({
          request_id: "request-2",
          first_engaged_at: "2026-09-01T14:00:00.000Z",
        }),
      ],
      searches: [
        {
          search_id: "search-1",
          traffic_class: "REAL",
          occurred_at: submittedAt,
          profession_code: "PROF:ELECTRICIAN",
          result_count_bucket: "ZERO",
          profile_opened: false,
          candidate_count: 0,
        },
        {
          search_id: "search-2",
          traffic_class: "REAL",
          occurred_at: submittedAt,
          profession_code: "PROF:ELECTRICIAN",
          result_count_bucket: "FIVE_PLUS",
          profile_opened: true,
          candidate_count: 7,
        },
      ],
      supply: [
        {
          craftsman_profile_id: "profile-1",
          traffic_class: "REAL",
          profession_code: "PROF:ELECTRICIAN",
          invitation_count: 4,
          engaged_count: 2,
          quote_count: 1,
          won_job_count: 1,
          completed_job_count: 1,
        },
      ],
    });

    expect(metric(dashboard, "median_request_to_engagement_hours")?.value).toBe(
      4,
    );
    expect(metric(dashboard, "zero_result_search_rate")?.value).toBe(0.5);
    expect(metric(dashboard, "search_profile_open_rate")?.value).toBe(0.5);
    expect(metric(dashboard, "mean_candidates_per_search")?.value).toBe(3.5);
    expect(metric(dashboard, "invitation_response_rate")?.value).toBe(0.5);
  });

  it("rejects duplicate entity facts, impossible ordering and arbitrary PII fields", () => {
    expect(() =>
      buildAlphaAnalyticsDashboard({
        generated_at: "2026-09-30T00:00:00.000Z",
        requests: [requestFact(), requestFact()],
        searches: [],
        supply: [],
      }),
    ).toThrow("duplicate request_id");

    expect(() =>
      buildAlphaAnalyticsDashboard({
        generated_at: "2026-09-30T00:00:00.000Z",
        requests: [
          requestFact({ first_engaged_at: "2026-08-31T08:00:00.000Z" }),
        ],
        searches: [],
        supply: [],
      }),
    ).toThrow("timestamps must be monotonic");

    expect(() =>
      buildAlphaAnalyticsDashboard({
        generated_at: "2026-09-30T00:00:00.000Z",
        requests: [
          {
            ...requestFact(),
            email: "must-not-enter-analytics@example.test",
          } as AlphaRequestJourneyFact,
        ],
        searches: [],
        supply: [],
      }),
    ).toThrow("unknown analytics fact property: email");
  });

  it("suppresses tiny cohorts with an explicit configurable floor", () => {
    expect(segmentMayBePublished(4)).toBe(false);
    expect(segmentMayBePublished(5)).toBe(true);
    expect(segmentMayBePublished(2, 3)).toBe(false);
    expect(segmentMayBePublished(3, 3)).toBe(true);
  });
});
