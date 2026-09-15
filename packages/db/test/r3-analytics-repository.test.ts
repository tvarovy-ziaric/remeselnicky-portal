import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createR3AnalyticsLeaseStore,
  createR3AnalyticsObservationRepository,
} from "../src/r3-analytics-repository.js";

const eventId = "91000000-0000-4000-8000-000000000001";
const actorId = "91000000-0000-4000-8000-000000000002";
const requestId = "91000000-0000-4000-8000-000000000003";
const leaseToken = "91000000-0000-4000-8000-000000000004";

describe("R3 analytics DB repository", () => {
  it("claims its independent delivery even when the global outbox is already published", async () => {
    const fixture = scriptedSql([
      [
        {
          attempt: 2,
          eventId,
          eventName: "r3.analytics.job_request_submitted_v2",
          leaseToken,
          occurredAt: new Date("2026-09-15T10:00:00.000Z"),
          payload: {
            budget_provided: false,
            initiator: "USER",
            job_request_id: requestId,
            photo_count_bucket: "NONE",
            profession_code: "PROF:MURAR",
            profile_context: "CUSTOMER",
            subject_user_id: actorId,
            timing_option: "NOT_PROVIDED",
            traffic_class: "TEST",
          },
        },
      ],
    ]);
    const lease = await createR3AnalyticsLeaseStore(fixture.sql).claimNext({
      leaseDurationMs: 30_000,
      now: new Date(),
    });
    expect(lease?.kind).toBe("VALID");
    if (lease?.kind !== "VALID") throw new Error("expected valid lease");
    expect(lease?.observation).toMatchObject({
      event_id: eventId,
      event_name: "job_request_submitted",
      schema_version: 2,
      subject: { is_internal: false, is_test: true },
    });
    expect(fixture.statements[0]).not.toMatch(/source\.status/u);
    expect(JSON.stringify(lease)).not.toMatch(
      /email|phone|body|address|storage/iu,
    );
  });

  it("commits the independent consumer effect only after delivery", async () => {
    const fixture = scriptedSql([
      [{ sourceEventId: eventId }],
      [{ sourceEventId: eventId }],
    ]);
    const store = createR3AnalyticsLeaseStore(fixture.sql);
    await expect(
      store.markDelivered(
        {
          attempt: 1,
          eventId,
          kind: "VALID",
          leaseToken,
          observation: {
            event_id: eventId,
            event_name: "job_request_started",
            occurred_at: new Date(),
            properties: { job_request_id: requestId },
            schema_version: 1,
            subject: {
              is_internal: false,
              is_test: false,
              kind: "ACTOR",
              profile_context: "CUSTOMER",
              user_id: actorId,
            },
          },
        },
        new Date(),
      ),
    ).resolves.toBe(true);
    expect(fixture.statements[1]).toContain("outbox_consumer_effects");
    expect(fixture.statements[1]).toContain("consumer_name");
  });

  it("records a minimal server-authorized observation and rejects target-shape errors before SQL", async () => {
    const fixture = scriptedSql([[], [{ sourceEventId: eventId }]]);
    const repository = createR3AnalyticsObservationRepository(fixture.sql);
    await expect(
      repository.record({
        actorUserId: actorId,
        commandId: eventId,
        jobRequestId: requestId,
        kind: "QUOTE_COMPARISON_OPENED",
      }),
    ).resolves.toBe("RECORDED");
    expect(fixture.statements[1]).toContain(
      "r3_analytics_observation_commands",
    );
    await expect(
      repository.record({
        actorUserId: actorId,
        commandId: eventId,
        jobRequestId: requestId,
        kind: "QUOTE_VIEWED",
      }),
    ).rejects.toThrow(/target shape/u);
  });
});

function scriptedSql(responses: unknown[][]): {
  sql: Sql;
  statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  const transaction = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  }) as unknown as Sql;
  const sql = Object.assign(transaction, {
    begin: (callback: (tx: Sql) => unknown) => callback(transaction),
  }) as unknown as Sql;
  return { sql, statements };
}
