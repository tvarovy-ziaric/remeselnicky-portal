import type { MediaProcessingJob } from "@portal/media";
import type { EnqueueJob, QueueDelivery } from "@portal/queue";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createMediaProcessingQueue } from "../src/media-processing-queue.js";

const assetId = "92000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-15T10:00:00.000Z");

describe("media processing PostgreSQL queue", () => {
  it("returns the atomic trigger-created job as an exact duplicate", async () => {
    const fixture = scriptedSql([
      [{ assetId, kind: "IMAGE", maxAttempts: 10 }],
    ]);
    await expect(
      createMediaProcessingQueue(fixture.sql).enqueue(job("IMAGE")),
    ).resolves.toEqual({ jobId: assetId, status: "duplicate" });
    expect(fixture.statements).toHaveLength(1);
  });

  it("claims only due/reclaimable work with an opaque lease", async () => {
    const fixture = scriptedSql([
      [
        {
          assetId,
          attempt: 2,
          availableAt: now,
          enqueuedAt: now,
          kind: "DOCUMENT",
          maxAttempts: 10,
        },
      ],
    ]);
    await expect(
      createMediaProcessingQueue(fixture.sql).take(now.valueOf()),
    ).resolves.toEqual({
      attempt: 2,
      availableAt: now.valueOf(),
      correlationId: assetId,
      enqueuedAt: now.valueOf(),
      eventId: assetId,
      jobId: assetId,
      maxAttempts: 10,
      name: "media.document.validate",
      payload: { assetId, kind: "DOCUMENT" },
    });
    expect(fixture.statements[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(fixture.statements[0]).toContain("lease_expires_at");
  });

  it("requires the exact active attempt for retry, success and terminal state", async () => {
    const fixture = scriptedSql([[{ assetId }], [{ assetId }], [{ assetId }]]);
    const queue = createMediaProcessingQueue(fixture.sql);
    const current = delivery("IMAGE");
    await queue.retry(current, {
      availableAt: now.valueOf() + 1_000,
      errorCode: "STORAGE_UNAVAILABLE",
    });
    await queue.acknowledge(current);
    await queue.moveToTerminal(current, {
      errorCode: "MALFORMED_IMAGE",
      failedAt: now.valueOf(),
      reason: "non_retryable",
      runId: "run-1",
    });
    expect(
      fixture.statements.every((statement) =>
        statement.includes("attempt_count"),
      ),
    ).toBe(true);
    expect(
      fixture.statements.every((statement) =>
        statement.includes("lease_expires_at >"),
      ),
    ).toBe(true);
  });

  it("fails closed when an active lease was lost", async () => {
    const fixture = scriptedSql([[]]);
    await expect(
      createMediaProcessingQueue(fixture.sql).acknowledge(delivery("IMAGE")),
    ).rejects.toThrow(/lost its active lease/u);
  });
});

function job(kind: MediaProcessingJob["kind"]): EnqueueJob<MediaProcessingJob> {
  return {
    correlationId: assetId,
    eventId: assetId,
    jobId: assetId,
    maxAttempts: 10,
    name:
      kind === "IMAGE" ? "media.image.canonicalize" : "media.document.validate",
    payload: { assetId, kind },
  };
}

function delivery(
  kind: MediaProcessingJob["kind"],
): QueueDelivery<MediaProcessingJob> {
  return {
    ...job(kind),
    attempt: 1,
    availableAt: now.valueOf(),
    enqueuedAt: now.valueOf(),
  };
}

function scriptedSql(responses: unknown[][]): {
  readonly sql: Sql;
  readonly statements: string[];
} {
  const statements: string[] = [];
  let index = 0;
  const sql = ((parts: TemplateStringsArray) => {
    statements.push(parts.join("?"));
    return Promise.resolve(responses[index++] ?? []);
  }) as unknown as Sql;
  return { sql, statements };
}
