import { describe, expect, it, vi } from "vitest";

import {
  exponentialBackoff,
  InMemoryQueue,
  NonRetryableJobError,
  RetryableJobError,
  createQueueWorker,
  type EnqueueJob,
  type QueueTelemetryEvent,
} from "../src/index.js";

interface TestPayload {
  readonly secret: string;
}

const job: EnqueueJob<TestPayload> = {
  correlationId: "correlation-1",
  eventId: "event-1",
  jobId: "job-1",
  maxAttempts: 3,
  name: "test.job",
  payload: { secret: "private-payload-value" },
};

describe("queue worker", () => {
  it("processes a job once and preserves all correlation identifiers", async () => {
    let now = 1_000;
    const queue = new InMemoryQueue<TestPayload>(() => now);
    const telemetry: QueueTelemetryEvent[] = [];
    const handler = vi.fn(() => Promise.resolve());
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 100, maxDelayMs: 1_000 },
      createRunId: () => "run-1",
      handler,
      now: () => now,
      queue,
      telemetry: { record: (event) => telemetry.push(event) },
    });

    await expect(queue.enqueue(job)).resolves.toEqual({
      jobId: "job-1",
      status: "enqueued",
    });
    await expect(queue.enqueue(job)).resolves.toEqual({
      jobId: "job-1",
      status: "duplicate",
    });
    await expect(worker.processNext()).resolves.toEqual({
      attempt: 1,
      correlationId: "correlation-1",
      eventId: "event-1",
      jobId: "job-1",
      runId: "run-1",
      status: "succeeded",
    });

    expect(handler).toHaveBeenCalledWith(job.payload, {
      attempt: 1,
      correlationId: "correlation-1",
      eventId: "event-1",
      jobId: "job-1",
      runId: "run-1",
    });
    expect(telemetry.map((event) => event.type)).toEqual([
      "job_attempt_started",
      "job_attempt_succeeded",
    ]);
    await expect(queue.snapshot(now)).resolves.toMatchObject({
      depth: 0,
      failedAttempts: 0,
      inFlight: 0,
      retriesScheduled: 0,
      succeeded: 1,
      terminalFailures: 0,
    });
    now += 1;
    await expect(worker.processNext()).resolves.toEqual({ status: "idle" });
  });

  it("schedules deterministic exponential retries before succeeding", async () => {
    let now = 5_000;
    let calls = 0;
    const queue = new InMemoryQueue<TestPayload>(() => now);
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 200, maxDelayMs: 1_000 },
      createRunId: () => `run-${calls + 1}`,
      handler: () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new RetryableJobError("PROVIDER_UNAVAILABLE"))
          : Promise.resolve();
      },
      now: () => now,
      queue,
    });
    await queue.enqueue(job);

    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 1,
      availableAt: 5_200,
      status: "retry_scheduled",
    });
    now = 5_199;
    await expect(worker.processNext()).resolves.toEqual({ status: "idle" });
    now = 5_200;
    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 2,
      availableAt: 5_600,
      status: "retry_scheduled",
    });
    now = 5_600;
    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 3,
      status: "succeeded",
    });
    await expect(queue.snapshot(now)).resolves.toMatchObject({
      failedAttempts: 2,
      retriesScheduled: 2,
      succeeded: 1,
      terminalFailures: 0,
    });
  });

  it("moves a non-retryable failure directly to a safe terminal record", async () => {
    const queue = new InMemoryQueue<TestPayload>(() => 100);
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 100, maxDelayMs: 1_000 },
      createRunId: () => "run-terminal",
      handler: () =>
        Promise.reject(
          new NonRetryableJobError("INVALID_JOB", "private failure detail"),
        ),
      now: () => 100,
      queue,
    });
    await queue.enqueue(job);

    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 1,
      reason: "non_retryable",
      status: "terminal_failure",
    });
    await expect(queue.terminalFailures()).resolves.toEqual([
      {
        attempts: 1,
        correlationId: "correlation-1",
        errorCode: "INVALID_JOB",
        eventId: "event-1",
        failedAt: 100,
        jobId: "job-1",
        name: "test.job",
        reason: "non_retryable",
        runId: "run-terminal",
      },
    ]);
  });

  it("makes retry exhaustion terminal and observable", async () => {
    let now = 1_000;
    let run = 0;
    const queue = new InMemoryQueue<TestPayload>(() => now);
    const telemetry: QueueTelemetryEvent[] = [];
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 50, maxDelayMs: 500 },
      createRunId: () => `run-${++run}`,
      handler: () => Promise.reject(new Error("provider still unavailable")),
      now: () => now,
      queue,
      telemetry: { record: (event) => telemetry.push(event) },
    });
    await queue.enqueue({ ...job, maxAttempts: 2 });

    await worker.processNext();
    now = 1_050;
    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 2,
      reason: "retries_exhausted",
      runId: "run-2",
      status: "terminal_failure",
    });
    await expect(queue.snapshot(now)).resolves.toMatchObject({
      depth: 0,
      failedAttempts: 2,
      retriesScheduled: 1,
      terminalFailures: 1,
    });
    expect(telemetry.at(-1)).toMatchObject({
      correlationId: "correlation-1",
      errorCode: "UNEXPECTED",
      eventId: "event-1",
      jobId: "job-1",
      reason: "retries_exhausted",
      runId: "run-2",
      type: "job_terminal_failure",
    });
  });

  it("never puts payloads or exception messages into telemetry", async () => {
    const queue = new InMemoryQueue<TestPayload>(() => 100);
    const telemetry: QueueTelemetryEvent[] = [];
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 100, maxDelayMs: 1_000 },
      createRunId: () => "run-private",
      handler: (payload) =>
        Promise.reject(new Error(`do not log ${payload.secret}`)),
      now: () => 100,
      queue,
      telemetry: { record: (event) => telemetry.push(event) },
    });
    await queue.enqueue({ ...job, maxAttempts: 1 });

    await worker.processNext();

    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain(job.payload.secret);
    expect(serialized).not.toContain("do not log");
  });

  it("retries safely when run ID generation fails without stranding the delivery", async () => {
    let now = 100;
    let idCalls = 0;
    const queue = new InMemoryQueue<TestPayload>(() => now);
    const telemetry: QueueTelemetryEvent[] = [];
    const handler = vi.fn(() => Promise.resolve());
    const worker = createQueueWorker({
      backoff: { baseDelayMs: 25, maxDelayMs: 100 },
      createRunId: () => {
        idCalls += 1;
        if (idCalls === 1) throw new Error("private generator detail");
        return "run-recovered";
      },
      handler,
      now: () => now,
      queue,
      telemetry: { record: (event) => telemetry.push(event) },
    });
    await queue.enqueue(job);

    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 1,
      availableAt: 125,
      status: "retry_scheduled",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(telemetry.at(-1)).toMatchObject({
      errorCode: "RUN_ID_GENERATION_FAILED",
      type: "job_retry_scheduled",
    });
    expect(JSON.stringify(telemetry)).not.toContain("private generator detail");
    expect(JSON.stringify(telemetry)).not.toContain(job.payload.secret);

    now = 125;
    await expect(worker.processNext()).resolves.toMatchObject({
      attempt: 2,
      runId: "run-recovered",
      status: "succeeded",
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("queue invariants", () => {
  it("exposes pending and in-flight age without exposing payloads", async () => {
    let now = 100;
    const queue = new InMemoryQueue<TestPayload>(() => now);
    await queue.enqueue(job);
    now = 175;

    await expect(queue.snapshot(now)).resolves.toMatchObject({
      depth: 1,
      oldestPendingAgeMs: 75,
    });
    await queue.take(now);
    now = 225;
    const snapshot = await queue.snapshot(now);
    expect(snapshot).toMatchObject({
      depth: 0,
      inFlight: 1,
      oldestInFlightAgeMs: 50,
    });
    expect(JSON.stringify(snapshot)).not.toContain(job.payload.secret);
  });

  it("rejects malformed identifiers and stale acknowledgements", async () => {
    const queue = new InMemoryQueue<TestPayload>(() => 100);
    expect(() => queue.enqueue({ ...job, correlationId: "" })).toThrow(
      "correlationId",
    );
    await queue.enqueue(job);
    const delivery = await queue.take(100);
    expect(delivery).toBeDefined();
    if (delivery === undefined) throw new Error("Expected a delivery");
    await queue.acknowledge(delivery);
    expect(() => queue.acknowledge(delivery)).toThrow("stale");
  });

  it("caps deterministic exponential backoff", () => {
    expect(
      [1, 2, 3, 4, 5].map((attempt) =>
        exponentialBackoff(attempt, {
          baseDelayMs: 100,
          maxDelayMs: 500,
        }),
      ),
    ).toEqual([100, 200, 400, 500, 500]);
  });
});
