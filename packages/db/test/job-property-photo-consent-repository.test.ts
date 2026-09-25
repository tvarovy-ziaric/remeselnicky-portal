import type { UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createJobPropertyPhotoConsentRepository,
  JobPropertyPhotoConsentIdempotencyError,
} from "../src/index.js";

const customerUserId = "73000000-0000-4000-8000-000000000001" as UserId;
const jobId = "73000000-0000-4000-8000-000000000002";
const mediaAssetId = "73000000-0000-4000-8000-000000000003";
const policyVersionId = "73000000-0000-4000-8000-000000000004";
const eventId = "73000000-0000-4000-8000-000000000005";
const correlationId = "73000000-0000-4000-8000-000000000006";
const now = new Date("2026-09-25T09:00:00.000Z");

function fakeSql(responses: unknown[]) {
  const calls: TemplateStringsArray[] = [];
  const transaction = vi.fn(
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      calls.push(strings);
      return Promise.resolve(responses.shift() ?? []);
    },
  );
  const root = Object.assign(vi.fn(), {
    begin: vi.fn((operation: (sql: unknown) => unknown) =>
      operation(transaction),
    ),
  });
  return { calls, sql: root as unknown as Sql };
}

function decision(
  action: "DECLINED" | "GRANTED" | "WITHDRAWN" = "GRANTED",
  expectedRevision = 0,
) {
  return {
    action,
    correlationId,
    customerUserId,
    eventId,
    expectedRevision,
    jobId,
    mediaAssetId,
    policyVersionId,
  } as const;
}

describe("Job property-photo consent repository", () => {
  it("lists only minimized same-Job photo decisions and approved policy identity", async () => {
    const fixture = fakeSql([
      [{ allowed: true }],
      [
        {
          action: null,
          mediaAssetId,
          occurredAt: null,
          policyVersionId: null,
          revision: 0,
        },
      ],
      [
        {
          contentSha256: "a".repeat(64),
          policyVersionId,
          versionLabel: "property-photo-v1",
        },
      ],
    ]);
    await expect(
      createJobPropertyPhotoConsentRepository(fixture.sql).listForCustomerJob({
        customerUserId,
        jobId,
      }),
    ).resolves.toMatchObject({
      items: [{ mediaAssetId, revision: 0 }],
      policy: { policyVersionId, versionLabel: "property-photo-v1" },
    });
    expect(fixture.calls.map((call) => call.join("?")).join("\n")).not.toMatch(
      /storage_key|public_url/iu,
    );
  });

  it("fails closed for a foreign Job", async () => {
    const fixture = fakeSql([[]]);
    await expect(
      createJobPropertyPhotoConsentRepository(fixture.sql).listForCustomerJob({
        customerUserId,
        jobId,
      }),
    ).resolves.toBeNull();
  });

  it("appends a resource-specific grant only with an approved policy", async () => {
    const inserted = {
      action: "GRANTED" as const,
      correlationId,
      customerUserId,
      eventId,
      jobId,
      mediaAssetId,
      occurredAt: now,
      policyVersionId,
      revision: 1,
    };
    const fixture = fakeSql([
      [],
      [],
      [{ action: null, policyVersionId: null, revision: 0 }],
      [{ approved: true }],
      [inserted],
    ]);
    await expect(
      createJobPropertyPhotoConsentRepository(fixture.sql).appendDecision(
        decision(),
      ),
    ).resolves.toEqual({ event: inserted, status: "APPENDED" });
  });

  it("withdraws against the exact original policy without rewriting the grant", async () => {
    const inserted = {
      action: "WITHDRAWN" as const,
      correlationId,
      customerUserId,
      eventId,
      jobId,
      mediaAssetId,
      occurredAt: now,
      policyVersionId,
      revision: 2,
    };
    const fixture = fakeSql([
      [],
      [],
      [{ action: "GRANTED", policyVersionId, revision: 1 }],
      [inserted],
    ]);
    await expect(
      createJobPropertyPhotoConsentRepository(fixture.sql).appendDecision(
        decision("WITHDRAWN", 1),
      ),
    ).resolves.toEqual({ event: inserted, status: "APPENDED" });
    expect(
      fixture.calls.some((call) =>
        call
          .join("?")
          .includes("INSERT INTO job_property_photo_consent_events"),
      ),
    ).toBe(true);
  });

  it("rejects event-id reuse with another resource intent", async () => {
    const fixture = fakeSql([
      [],
      [
        {
          action: "GRANTED",
          correlationId,
          customerUserId,
          eventId,
          jobId,
          mediaAssetId: "73000000-0000-4000-8000-000000000099",
          occurredAt: now,
          policyVersionId,
          revision: 1,
        },
      ],
    ]);
    await expect(
      createJobPropertyPhotoConsentRepository(fixture.sql).appendDecision(
        decision(),
      ),
    ).rejects.toBeInstanceOf(JobPropertyPhotoConsentIdempotencyError);
  });
});
