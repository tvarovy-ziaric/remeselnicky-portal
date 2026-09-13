import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import { runWorker } from "./worker.js";
import { createWorkerQueueTelemetrySink, runWorkerLoop } from "./service.js";

describe("worker skeleton", () => {
  it("loads the shared contract and domain package boundaries", () => {
    expect(
      runWorker({ environment: "staging", releaseRevision: "test-revision" }),
    ).toEqual({
      apiVersion: "v1",
      environment: "staging",
      releaseRevision: "test-revision",
      service: "worker",
      sharedDomainLoaded: true,
      status: "ready",
    });
  });

  it("runs as an independently stoppable polling process", async () => {
    const abortController = new AbortController();
    let polls = 0;

    await runWorkerLoop({
      processor: {
        processNext: () => {
          polls += 1;
          abortController.abort();
          return Promise.resolve({ status: "idle" });
        },
      },
      signal: abortController.signal,
      sleep: () => Promise.reject(new Error("must not sleep after abort")),
    });

    expect(polls).toBe(1);
  });

  it("preserves queue correlation and run semantics in structured logs", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const sink = createWorkerQueueTelemetrySink({
      debug: vi.fn(),
      error,
      info,
      warn,
    });
    const base = {
      attempt: 2,
      correlationId: "correlation-123",
      eventId: "event-123",
      jobId: "job-123",
      jobName: "send-notification",
      occurredAt: 1_789_382_400_000,
      runId: "run-123",
    } as const;

    sink.record({ ...base, type: "job_attempt_started" });
    sink.record({
      ...base,
      delayMs: 1_000,
      errorCode: "PROVIDER_TIMEOUT",
      type: "job_retry_scheduled",
    });
    sink.record({
      ...base,
      errorCode: "INVALID_JOB",
      reason: "non_retryable",
      type: "job_terminal_failure",
    });

    expect(info).toHaveBeenCalledWith("job_attempt_started", {
      ...base,
      type: "job_attempt_started",
    });
    expect(warn).toHaveBeenCalledWith("job_retry_scheduled", {
      ...base,
      delayMs: 1_000,
      errorCode: "PROVIDER_TIMEOUT",
      type: "job_retry_scheduled",
    });
    expect(error).toHaveBeenCalledWith("job_terminal_failure", {
      ...base,
      errorCode: "INVALID_JOB",
      reason: "non_retryable",
      type: "job_terminal_failure",
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("payload");
  });
});
