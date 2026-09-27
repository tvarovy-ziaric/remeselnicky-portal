import { describe, expect, it } from "vitest";

import { parseAlphaDashboard } from "./admin-analytics-model";

const GROUP_IDS = {
  core_funnel: [
    "requests_submitted",
    "requests_with_engagement_rate",
    "requests_with_quote_rate",
    "requests_confirmed_rate",
    "confirmed_jobs_completed_rate",
    "completed_jobs_reviewed_rate",
  ],
  supply: [
    "public_approved_craftsmen",
    "invitation_response_rate",
    "quotes_per_engaged_provider",
    "wins_per_quote",
  ],
  search_liquidity: [
    "searches",
    "zero_result_search_rate",
    "search_profile_open_rate",
    "mean_candidates_per_search",
  ],
  speed: [
    "median_request_to_engagement_hours",
    "median_request_to_quote_hours",
    "median_quote_to_confirmation_hours",
    "median_confirmation_to_start_hours",
    "median_start_to_completion_hours",
    "p90_request_to_engagement_hours",
    "p90_request_to_quote_hours",
    "p90_quote_to_confirmation_hours",
    "p90_confirmation_to_start_hours",
    "p90_start_to_completion_hours",
  ],
  quality_process: [
    "completion_attempts_per_completed_job",
    "change_order_job_rate",
    "dispute_job_rate",
    "report_job_rate",
  ],
  review: ["completion_to_review_rate"],
} as const;

describe("alpha dashboard parser", () => {
  it("accepts the complete versioned aggregate and strips wire names", () => {
    const parsed = parseAlphaDashboard(fixture());

    expect(parsed?.definitionVersion).toBe("D28_ALPHA_V1");
    expect(parsed?.groups.flatMap(({ metrics }) => metrics)).toHaveLength(29);
    expect(parsed?.groups[0]?.metrics[0]).toEqual({
      definitionId: "requests_submitted",
      denominator: 10,
      numerator: 5,
      value: 0.5,
    });
  });

  it("fails closed for incomplete, unknown or privacy-expanding payloads", () => {
    const incomplete = fixture();
    incomplete.dashboard.review = [];
    expect(parseAlphaDashboard(incomplete)).toBeUndefined();

    const unknown = fixture();
    unknown.dashboard.review[0]!.definition_id = "customer_email";
    expect(parseAlphaDashboard(unknown)).toBeUndefined();

    const expanded = fixture() as ReturnType<typeof fixture> & {
      email?: string;
    };
    expanded.email = "should-not-cross-the-boundary@example.test";
    expect(parseAlphaDashboard(expanded)).toBeUndefined();
  });

  it("rejects an unrecognized definition version or non-canonical range", () => {
    const version = fixture() as ReturnType<typeof fixture> & {
      dashboard: ReturnType<typeof fixture>["dashboard"] & {
        definition_version: string;
      };
    };
    version.dashboard.definition_version = "D28_ALPHA_V2";
    expect(parseAlphaDashboard(version)).toBeUndefined();

    const range = fixture();
    range.range.from = "2026-09-01";
    expect(parseAlphaDashboard(range)).toBeUndefined();
  });
});

function fixture() {
  const metric = (definition_id: string) => ({
    definition_id,
    denominator: 10,
    numerator: 5,
    value: 0.5,
  });
  return {
    dashboard: {
      definition_version: "D28_ALPHA_V1",
      generated_at: "2026-10-01T00:00:00.000Z",
      core_funnel: GROUP_IDS.core_funnel.map(metric),
      supply: GROUP_IDS.supply.map(metric),
      search_liquidity: GROUP_IDS.search_liquidity.map(metric),
      speed: GROUP_IDS.speed.map(metric),
      quality_process: GROUP_IDS.quality_process.map(metric),
      review: GROUP_IDS.review.map(metric),
    },
    range: {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    },
  };
}
