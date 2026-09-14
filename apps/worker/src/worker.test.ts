import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createPortalMetrics } from "@portal/observability";

import { runWorker } from "./worker.js";
import {
  createWorkerQueueTelemetrySink,
  createWorkerReadiness,
  runWorkerLoop,
} from "./service.js";

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

  it("publishes queue metrics without identifier labels", () => {
    const metrics = createPortalMetrics({
      environment: "staging",
      releaseRevision: "test-revision",
      service: "worker",
    });
    const sink = createWorkerQueueTelemetrySink(
      { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      metrics,
    );

    sink.record({
      attempt: 1,
      correlationId: "private-correlation-123",
      eventId: "private-event-123",
      jobId: "private-job-123",
      jobName: "send-notification",
      occurredAt: 100,
      runId: "private-run-123",
      type: "job_attempt_succeeded",
    });

    const output = metrics.render();
    expect(output).toContain('outcome="succeeded"');
    expect(output).not.toContain("private-job-123");
    expect(output).not.toContain("private-correlation-123");
  });

  it("reports readiness only while the polling heartbeat is fresh", () => {
    let now = 100;
    const readiness = createWorkerReadiness({
      clock: () => now,
      maxHeartbeatAgeMs: 50,
    });

    expect(readiness.isReady()).toBe(false);
    readiness.heartbeat();
    expect(readiness.isReady()).toBe(true);
    now = 151;
    expect(readiness.isReady()).toBe(false);
    readiness.heartbeat();
    readiness.stop();
    expect(readiness.isReady()).toBe(false);
  });

  it("observes queue snapshots without changing the polling result", async () => {
    const abortController = new AbortController();
    const setQueueSnapshot = vi.fn();
    const heartbeat = vi.fn();
    await runWorkerLoop({
      heartbeat,
      metrics: {
        contentType: "text/plain; version=0.0.4; charset=utf-8",
        recordDatabaseProbe: vi.fn(),
        recordHttp: vi.fn(),
        recordQueueEvent: vi.fn(),
        render: () => "",
        setQueueSnapshot,
        setWorkerReady: vi.fn(),
      },
      now: () => 1_000,
      processor: {
        processNext: () => {
          abortController.abort();
          return Promise.resolve({ status: "idle" });
        },
      },
      queueMetrics: {
        snapshot: () =>
          Promise.resolve({
            depth: 3,
            inFlight: 1,
            oldestInFlightAgeMs: 50,
            oldestPendingAgeMs: 500,
          }),
      },
      signal: abortController.signal,
    });

    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(setQueueSnapshot).toHaveBeenCalledWith({
      depth: 3,
      inFlight: 1,
      oldestInFlightAgeMs: 50,
      oldestPendingAgeMs: 500,
    });
  });
});
