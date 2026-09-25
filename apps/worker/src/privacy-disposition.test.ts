import {
  PRIVACY_DISPOSITION_JOB_NAME,
  PRIVACY_DISPOSITION_MAX_ATTEMPTS,
  type PrivacyDispositionJob,
} from "@portal/db";
import type { UserId } from "@portal/domain";
import { InMemoryQueue, RetryableJobError } from "@portal/queue";
import { describe, expect, it, vi } from "vitest";

import { createPrivacyDispositionWorker } from "./privacy-disposition.js";

const jobId = "93000000-0000-4000-8000-000000000011";
const caseId = "93000000-0000-4000-8000-000000000012";
const subjectUserId = "93000000-0000-4000-8000-000000000013" as UserId;
const policyVersionId = "93000000-0000-4000-8000-000000000014";
const payload: PrivacyDispositionJob = {
  caseId,
  category: "ACCOUNT_CORE",
  disposition: "ANONYMIZE",
  policyVersionId,
  sourceDispositionEventId: jobId,
  subjectUserId,
  tombstoneId: jobId,
};

async function enqueue(
  queue: InMemoryQueue<PrivacyDispositionJob>,
  job: PrivacyDispositionJob = payload,
) {
  await queue.enqueue({
    correlationId: caseId,
    eventId: jobId,
    jobId,
    maxAttempts: PRIVACY_DISPOSITION_MAX_ATTEMPTS,
    name: PRIVACY_DISPOSITION_JOB_NAME,
    payload: job,
  });
}

describe("privacy disposition worker", () => {
  it("executes one exact idempotent category job", async () => {
    const queue = new InMemoryQueue<PrivacyDispositionJob>(() => 1_000);
    const execute = vi.fn(() => Promise.resolve());
    const worker = createPrivacyDispositionWorker({
      createRunId: () => "privacy-run-1",
      executor: { execute },
      now: () => 1_000,
      queue,
    });
    await enqueue(queue);

    await expect(worker.processNext()).resolves.toMatchObject({
      jobId,
      status: "succeeded",
    });
    expect(execute).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ jobId, runId: "privacy-run-1" }),
    );
  });

  it("leaves transient partial failures retryable", async () => {
    let now = 1_000;
    const queue = new InMemoryQueue<PrivacyDispositionJob>(() => now);
    const execute = vi.fn(() =>
      Promise.reject(new RetryableJobError("CATEGORY_EXECUTOR_UNAVAILABLE")),
    );
    const worker = createPrivacyDispositionWorker({
      createRunId: () => "privacy-run-retry",
      executor: { execute },
      now: () => now,
      queue,
    });
    await enqueue(queue);

    await expect(worker.processNext()).resolves.toMatchObject({
      availableAt: 2_000,
      status: "retry_scheduled",
    });
    now = 2_000;
    await expect(worker.processNext()).resolves.toMatchObject({ attempt: 2 });
  });

  it("terminally rejects a malformed persisted category payload", async () => {
    const queue = new InMemoryQueue<PrivacyDispositionJob>(() => 1_000);
    const execute = vi.fn(() => Promise.resolve());
    const worker = createPrivacyDispositionWorker({
      createRunId: () => "privacy-run-invalid",
      executor: { execute },
      now: () => 1_000,
      queue,
    });
    await enqueue(queue, {
      ...payload,
      category: "NOT_A_CATEGORY" as PrivacyDispositionJob["category"],
    });

    await expect(worker.processNext()).resolves.toMatchObject({
      reason: "non_retryable",
      status: "terminal_failure",
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(queue.terminalFailures()).resolves.toEqual([
      expect.objectContaining({
        errorCode: "INVALID_PRIVACY_DISPOSITION_JOB",
        jobId,
      }),
    ]);
  });
});
