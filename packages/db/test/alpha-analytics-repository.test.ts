import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createAlphaAnalyticsDashboardRepository } from "../src/alpha-analytics-repository.js";

const from = new Date("2026-09-01T00:00:00.000Z");
const to = new Date("2026-10-01T00:00:00.000Z");

describe("D28 alpha analytics DB repository", () => {
  it("loads normalized facts into the versioned dashboard contract", async () => {
    const fixture = scriptedSql([
      [
        {
          changeOrderCount: 1,
          completedAt: new Date("2026-09-05T08:00:00.000Z"),
          completionAttemptCount: 1,
          confirmedAt: new Date("2026-09-02T08:00:00.000Z"),
          disputeCount: 0,
          firstEngagedAt: new Date("2026-09-01T10:00:00.000Z"),
          firstQuoteAt: new Date("2026-09-01T12:00:00.000Z"),
          invitationCount: 2,
          jobId: "job-1",
          professionCode: "PROF:ELECTRICIAN",
          quoteCount: 1,
          regionCode: "REGION:BA",
          reportCount: 0,
          requestId: "request-1",
          reviewedAt: new Date("2026-09-06T08:00:00.000Z"),
          startedAt: new Date("2026-09-03T08:00:00.000Z"),
          submittedAt: new Date("2026-09-01T08:00:00.000Z"),
          trafficClass: "REAL",
        },
      ],
      [
        {
          candidateCount: 0,
          occurredAt: new Date("2026-09-01T07:00:00.000Z"),
          professionCode: "PROF:ELECTRICIAN",
          profileOpened: false,
          regionCode: "REGION:BA",
          resultCountBucket: "ZERO",
          searchId: "search-1",
          trafficClass: "REAL",
        },
      ],
      [
        {
          completedJobCount: 1,
          craftsmanProfileId: "profile-1",
          engagedCount: 1,
          invitationCount: 2,
          professionCode: "PROF:ELECTRICIAN",
          quoteCount: 1,
          regionCode: "REGION:BA",
          trafficClass: "REAL",
          wonJobCount: 1,
        },
      ],
    ]);

    const dashboard = await createAlphaAnalyticsDashboardRepository(
      fixture.sql,
    ).load({ from, to });

    expect(dashboard.generated_at).toBe(to.toISOString());
    expect(dashboard.core_funnel[0]?.value).toBe(1);
    expect(dashboard.search_liquidity[1]?.value).toBe(1);
    expect(dashboard.supply[0]?.value).toBe(1);
    expect(fixture.statements.join("\n")).not.toMatch(
      /address|comment|description|details|note|ratings|statement/iu,
    );
  });

  it("records bounded search identity idempotently and detects collisions", async () => {
    const input = {
      actorUserId: "123e4567-e89b-42d3-a456-426614174000",
      candidateCount: 3,
      professionCode: "PROF:ELECTRICIAN",
      regionCode: "REGION:BA",
      resultCountBucket: "ONE_TO_FOUR" as const,
      searchId: "223e4567-e89b-42d3-a456-426614174000",
    };
    const matching = {
      actorUserId: input.actorUserId,
      candidateCount: input.candidateCount,
      professionCode: input.professionCode,
      regionCode: input.regionCode,
      resultCountBucket: input.resultCountBucket,
      searchId: input.searchId,
    };
    const fixture = scriptedSql([[], [matching]]);
    await expect(
      createAlphaAnalyticsDashboardRepository(fixture.sql).recordSearch(input),
    ).resolves.toBe("UNCHANGED");

    const collision = scriptedSql([
      [],
      [{ ...matching, professionCode: "PROF:PLUMBER" }],
    ]);
    await expect(
      createAlphaAnalyticsDashboardRepository(collision.sql).recordSearch(
        input,
      ),
    ).rejects.toThrow("analytics search_id collision");
  });
});

function scriptedSql(responses: unknown[][]): {
  sql: Sql;
  statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  }) as unknown as Sql;
  return { sql, statements };
}
