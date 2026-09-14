import { describe, expect, it, vi } from "vitest";

import {
  SEARCH_ANALYTICS_VERSION,
  analyticsEventCatalog,
  bucketResultCount,
  bucketShortlistSize,
  createAnalytics,
  createMemoryAnalyticsTransport,
  recordAppliedShortlistTransition,
  recordSearchExecuted,
  validateAnalyticsEnvelope,
  type AnalyticsSubject,
  type AnalyticsTransport,
} from "../src/index.js";

const searchId = "123e4567-e89b-42d3-a456-426614174000";
const commandId = "223e4567-e89b-42d3-a456-426614174000";
const profileId = "323e4567-e89b-42d3-a456-426614174000";
const actor: AnalyticsSubject = Object.freeze({
  is_internal: false,
  is_test: false,
  kind: "ACTOR",
  profile_context: "CUSTOMER",
  user_id: "423e4567-e89b-42d3-a456-426614174000",
});

describe("R2 search analytics catalog", () => {
  it("keeps UX, query and committed domain provenance distinct", () => {
    expect(analyticsEventCatalog.public_profile_viewed.source).toBe(
      "CLIENT_UX",
    );
    expect(analyticsEventCatalog.search_started.source).toBe("CLIENT_UX");
    expect(analyticsEventCatalog.search_results_viewed.source).toBe(
      "CLIENT_UX",
    );
    expect(
      analyticsEventCatalog.craftsman_profile_opened_from_search.source,
    ).toBe("CLIENT_UX");
    expect(analyticsEventCatalog.search_executed.source).toBe("SERVER_QUERY");
    expect(analyticsEventCatalog.shortlist_added.source).toBe("SERVER_DOMAIN");
    expect(analyticsEventCatalog.shortlist_removed.source).toBe(
      "SERVER_DOMAIN",
    );
  });

  it("records only bucketed server liquidity facts with optional coarse area", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });

    await expect(
      recordSearchExecuted({
        analytics,
        availability: {
          filterUsed: false,
          indicativelyAvailableCount: { count: 2, kind: "EXACT" },
          timingSupplied: true,
        },
        eligibleResultCount: { kind: "AT_LEAST_FIVE" },
        includeOutsideDeclaredArea: false,
        location: {
          area: { code: "REGION:SK-BL", granularity: "REGION" },
          scope: "MUNICIPALITY_SELECTED",
        },
        professionCode: "PROF:ELECTRICIAN",
        searchId,
        skillFilterUsed: true,
        sortMode: "RECOMMENDED",
        specializationCode: "SPEC:LOW_VOLTAGE",
        subject: actor,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "DELIVERED" }));

    expect(transport.events()).toHaveLength(1);
    expect(transport.events()[0]).toMatchObject({
      event_name: "search_executed",
      event_source: "SERVER_QUERY",
      properties: {
        eligible_result_count_bucket: "FIVE_PLUS",
        indicatively_available_count_bucket: "ONE_TO_FOUR",
        location_area_code: "REGION:SK-BL",
        location_area_granularity: "REGION",
        location_scope: "MUNICIPALITY_SELECTED",
        profession_code: "PROF:ELECTRICIAN",
        search_id: searchId,
        search_version: SEARCH_ANALYTICS_VERSION,
      },
    });
    expect(transport.events()[0]?.properties).not.toHaveProperty(
      "municipality_code",
    );
    expect(transport.events()[0]?.properties).not.toHaveProperty(
      "result_profile_ids",
    );
  });

  it("requires authoritative total or at-least-five probe evidence", () => {
    expect(bucketResultCount({ count: 0, kind: "EXACT" })).toBe("ZERO");
    expect(bucketResultCount({ count: 4, kind: "EXACT" })).toBe("ONE_TO_FOUR");
    expect(bucketResultCount({ kind: "AT_LEAST_FIVE" })).toBe("FIVE_PLUS");
    expect(() =>
      bucketResultCount({ count: 4, kind: "PAGE_LENGTH" } as never),
    ).toThrow(/exact total or at-least-five/u);
    expect(() => bucketResultCount(4 as never)).toThrow(/evidence/u);
  });

  it("uses a stable event ID for an idempotently retried search snapshot", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });
    const input = {
      analytics,
      availability: {
        filterUsed: false,
        indicativelyAvailableCount: null,
        timingSupplied: false,
      },
      eligibleResultCount: { count: 0, kind: "EXACT" },
      includeOutsideDeclaredArea: false,
      location: { scope: "NONE" },
      professionCode: "PROF:PAINTER",
      searchId,
      skillFilterUsed: false,
      sortMode: "NEAREST",
      subject: actor,
    } as const;

    const first = await recordSearchExecuted(input);
    const retry = await recordSearchExecuted(input);
    expect(first).toEqual(retry);
    expect(first).toEqual(expect.objectContaining({ status: "DELIVERED" }));
    expect(transport.events()[0]?.event_id).toBe(
      transport.events()[1]?.event_id,
    );
  });

  it("rejects private/high-cardinality search-result payloads", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });
    const forbidden = [
      { municipality_code: "MUNI:SECRET" },
      { raw_query: "elektrikár Ján person@example.test" },
      { coordinates: "48.1,17.1" },
      { result_profile_ids: [profileId] },
      { ranking_weight: 0.5 },
    ];

    for (const extra of forbidden) {
      await expect(
        analytics.capture({
          event_name: "search_results_viewed",
          properties: {
            ...extra,
            rendered_result_count_bucket: "ONE_TO_FOUR",
            search_id: searchId,
            search_version: SEARCH_ANALYTICS_VERSION,
            sort_mode: "RECOMMENDED",
          },
          subject: actor,
        } as never),
      ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
    }
    expect(transport.events()).toHaveLength(0);
  });

  it("allows one explicit opened profile without accepting a competitor list", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });

    await expect(
      analytics.capture({
        event_name: "craftsman_profile_opened_from_search",
        properties: {
          craftsman_profile_id: profileId,
          result_position: 3,
          search_id: searchId,
          search_version: SEARCH_ANALYTICS_VERSION,
          sort_mode: "BEST_RATED",
        },
        subject: actor,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "DELIVERED" }));
    expect(transport.events()[0]?.properties.result_position).toBe("3");
    expect(() =>
      validateAnalyticsEnvelope(transport.events()[0]),
    ).not.toThrow();
  });

  it("fails closed on incoherent timing and coarse-location pairs", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });
    const common = {
      eligible_result_count_bucket: "ZERO",
      include_outside_declared_area: false,
      indicative_availability_filter: false,
      indicatively_available_count_bucket: "NOT_APPLICABLE",
      location_scope: "MUNICIPALITY_SELECTED",
      profession_code: "PROF:PAINTER",
      search_id: searchId,
      search_version: SEARCH_ANALYTICS_VERSION,
      skill_filter_used: false,
      sort_mode: "RECOMMENDED",
      timing_supplied: false,
    } as const;

    await expect(
      analytics.capture({
        event_name: "search_executed",
        properties: { ...common, location_area_code: "DISTRICT:BA-I" },
        subject: actor,
      } as never),
    ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
    await expect(
      analytics.capture({
        event_name: "search_executed",
        properties: {
          ...common,
          indicative_availability_filter: true,
        },
        subject: actor,
      } as never),
    ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
  });
});

describe("R2 shortlist analytics hook", () => {
  it.each([
    [0, "ZERO"],
    [1, "ONE"],
    [2, "TWO_TO_FOUR"],
    [4, "TWO_TO_FOUR"],
    [5, "FIVE_TO_NINE"],
    [9, "FIVE_TO_NINE"],
    [10, "TEN_PLUS"],
  ] as const)("buckets shortlist size %i as %s", (size, bucket) => {
    expect(bucketShortlistSize(size)).toBe(bucket);
  });

  it("records only the committed transition metadata without a target/list", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });
    await expect(
      recordAppliedShortlistTransition({
        activeShortlistSize: 5,
        analytics,
        commandId,
        state: "ACTIVE",
        subject: actor,
      }),
    ).resolves.toEqual({ event_id: commandId, status: "DELIVERED" });

    expect(transport.events()[0]).toMatchObject({
      event_id: commandId,
      event_name: "shortlist_added",
      properties: {
        shortlist_size_bucket: "FIVE_TO_NINE",
      },
    });
    expect(transport.events()[0]?.properties).not.toHaveProperty(
      "craftsman_profile_id",
    );
  });

  it("rejects an impossible zero-size ADD event", async () => {
    const transport = createMemoryAnalyticsTransport("staging");
    const analytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport,
    });

    await expect(
      recordAppliedShortlistTransition({
        activeShortlistSize: 0,
        analytics,
        commandId,
        state: "ACTIVE",
        subject: actor,
      }),
    ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });
    expect(transport.events()).toHaveLength(0);
  });

  it("never rejects business work when instrumentation is malformed or down", async () => {
    const analytics = {
      capture: vi.fn(() => Promise.reject(new Error("provider unavailable"))),
      readiness: vi.fn(),
    } as unknown as Parameters<typeof recordSearchExecuted>[0]["analytics"];

    await expect(
      recordSearchExecuted({
        analytics,
        availability: {
          filterUsed: false,
          indicativelyAvailableCount: null,
          timingSupplied: false,
        },
        eligibleResultCount: { count: -1, kind: "EXACT" },
        includeOutsideDeclaredArea: false,
        location: { scope: "NONE" },
        professionCode: "PROF:PAINTER",
        searchId,
        skillFilterUsed: false,
        sortMode: "RECOMMENDED",
        subject: actor,
      }),
    ).resolves.toEqual({ reason: "INVALID_EVENT", status: "DROPPED" });

    const failingTransport: AnalyticsTransport = {
      deliver: () => Promise.reject(new Error("provider unavailable")),
      environment: "staging",
      kind: "PROVIDER",
    };
    const realAnalytics = createAnalytics({
      appVersion: "test",
      environment: "staging",
      platform: "WEB",
      transport: failingTransport,
    });
    await expect(
      recordAppliedShortlistTransition({
        activeShortlistSize: 1,
        analytics: realAnalytics,
        commandId,
        state: "ACTIVE",
        subject: actor,
      }),
    ).resolves.toEqual({
      event_id: commandId,
      reason: "TRANSPORT_UNAVAILABLE",
      status: "DROPPED",
    });
  });
});
