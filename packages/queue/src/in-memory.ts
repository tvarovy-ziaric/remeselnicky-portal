import type {
  EnqueueJob,
  EnqueueResult,
  Queue,
  QueueDelivery,
  QueueMetrics,
  RetryJobOptions,
  TerminalJobOptions,
  TerminalJobRecord,
} from "./contracts.js";

type StoredStatus = "in_flight" | "pending" | "succeeded" | "terminal";

interface StoredJob<Payload> extends EnqueueJob<Payload> {
  attempt: number;
  availableAt: number;
  readonly enqueuedAt: number;
  inFlightSince: number | undefined;
  status: StoredStatus;
}

interface MutableMetrics {
  failedAttempts: number;
  retriesScheduled: number;
  succeeded: number;
  terminalFailures: number;
}

/** Deterministic development/test adapter; production adapters implement Queue. */
export class InMemoryQueue<Payload> implements Queue<Payload> {
  readonly #jobs = new Map<string, StoredJob<Payload>>();
  readonly #metrics: MutableMetrics = {
    failedAttempts: 0,
    retriesScheduled: 0,
    succeeded: 0,
    terminalFailures: 0,
  };
  readonly #now: () => number;
  readonly #terminal: TerminalJobRecord[] = [];

  public constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  public acknowledge(delivery: QueueDelivery<Payload>): Promise<void> {
    const stored = this.#assertCurrentDelivery(delivery);
    stored.status = "succeeded";
    stored.inFlightSince = undefined;
    this.#metrics.succeeded += 1;
    return Promise.resolve();
  }

  public enqueue(job: EnqueueJob<Payload>): Promise<EnqueueResult> {
    validateJob(job);
    if (this.#jobs.has(job.jobId)) {
      return Promise.resolve({ jobId: job.jobId, status: "duplicate" });
    }

    const now = this.#now();
    this.#jobs.set(job.jobId, {
      ...job,
      attempt: 0,
      availableAt: now,
      enqueuedAt: now,
      inFlightSince: undefined,
      status: "pending",
    });
    return Promise.resolve({ jobId: job.jobId, status: "enqueued" });
  }

  public moveToTerminal(
    delivery: QueueDelivery<Payload>,
    options: TerminalJobOptions,
  ): Promise<void> {
    const stored = this.#assertCurrentDelivery(delivery);
    stored.status = "terminal";
    stored.inFlightSince = undefined;
    this.#metrics.failedAttempts += 1;
    this.#metrics.terminalFailures += 1;
    this.#terminal.push(
      Object.freeze({
        attempts: delivery.attempt,
        correlationId: delivery.correlationId,
        errorCode: options.errorCode,
        eventId: delivery.eventId,
        failedAt: options.failedAt,
        jobId: delivery.jobId,
        name: delivery.name,
        reason: options.reason,
        runId: options.runId,
      }),
    );
    return Promise.resolve();
  }

  public retry(
    delivery: QueueDelivery<Payload>,
    options: RetryJobOptions,
  ): Promise<void> {
    const stored = this.#assertCurrentDelivery(delivery);
    if (!Number.isFinite(options.availableAt)) {
      throw new RangeError("availableAt must be finite");
    }
    stored.availableAt = options.availableAt;
    stored.inFlightSince = undefined;
    stored.status = "pending";
    this.#metrics.failedAttempts += 1;
    this.#metrics.retriesScheduled += 1;
    return Promise.resolve();
  }

  public snapshot(now: number): Promise<QueueMetrics> {
    const pending = [...this.#jobs.values()].filter(
      (job) => job.status === "pending",
    );
    const inFlight = [...this.#jobs.values()].filter(
      (job) => job.status === "in_flight",
    );
    return Promise.resolve(
      Object.freeze({
        depth: pending.length,
        failedAttempts: this.#metrics.failedAttempts,
        inFlight: inFlight.length,
        oldestInFlightAgeMs: oldestAge(
          inFlight.flatMap((job) =>
            job.inFlightSince === undefined ? [] : [job.inFlightSince],
          ),
          now,
        ),
        oldestPendingAgeMs: oldestAge(
          pending.map((job) => job.enqueuedAt),
          now,
        ),
        retriesScheduled: this.#metrics.retriesScheduled,
        succeeded: this.#metrics.succeeded,
        terminalFailures: this.#metrics.terminalFailures,
      }),
    );
  }

  public take(now: number): Promise<QueueDelivery<Payload> | undefined> {
    const selected = [...this.#jobs.values()]
      .filter((job) => job.status === "pending" && job.availableAt <= now)
      .sort(
        (left, right) =>
          left.availableAt - right.availableAt ||
          left.enqueuedAt - right.enqueuedAt ||
          left.jobId.localeCompare(right.jobId),
      )[0];

    if (selected === undefined) return Promise.resolve(undefined);

    selected.attempt += 1;
    selected.inFlightSince = now;
    selected.status = "in_flight";
    return Promise.resolve(
      Object.freeze({
        attempt: selected.attempt,
        availableAt: selected.availableAt,
        correlationId: selected.correlationId,
        enqueuedAt: selected.enqueuedAt,
        eventId: selected.eventId,
        jobId: selected.jobId,
        maxAttempts: selected.maxAttempts,
        name: selected.name,
        payload: selected.payload,
      }),
    );
  }

  public terminalFailures(): Promise<readonly TerminalJobRecord[]> {
    return Promise.resolve([...this.#terminal]);
  }

  #assertCurrentDelivery(delivery: QueueDelivery<Payload>): StoredJob<Payload> {
    const stored = this.#jobs.get(delivery.jobId);
    if (
      stored === undefined ||
      stored.status !== "in_flight" ||
      stored.attempt !== delivery.attempt
    ) {
      throw new Error("Queue delivery is stale or is not in flight");
    }
    return stored;
  }
}

function oldestAge(
  timestamps: readonly number[],
  now: number,
): number | undefined {
  if (timestamps.length === 0) return undefined;
  return Math.max(0, now - Math.min(...timestamps));
}

function validateJob<Payload>(job: EnqueueJob<Payload>): void {
  for (const [name, value] of [
    ["correlationId", job.correlationId],
    ["eventId", job.eventId],
    ["jobId", job.jobId],
    ["name", job.name],
  ] as const) {
    if (value.trim().length === 0 || value.length > 128) {
      throw new TypeError(`${name} must be a non-empty bounded identifier`);
    }
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(job.name)) {
    throw new TypeError("name must be a bounded machine identifier");
  }
  if (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
}
