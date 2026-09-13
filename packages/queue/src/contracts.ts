export interface QueueJobIdentity {
  readonly correlationId: string;
  readonly eventId: string;
  readonly jobId: string;
}

export interface EnqueueJob<Payload> extends QueueJobIdentity {
  readonly maxAttempts: number;
  readonly name: string;
  readonly payload: Payload;
}

export interface QueueDelivery<Payload> extends EnqueueJob<Payload> {
  /** One-based delivery attempt. */
  readonly attempt: number;
  readonly availableAt: number;
  readonly enqueuedAt: number;
}

export interface RetryJobOptions {
  readonly availableAt: number;
  readonly errorCode: string;
}

export type TerminalFailureReason = "non_retryable" | "retries_exhausted";

export interface TerminalJobOptions {
  readonly errorCode: string;
  readonly failedAt: number;
  readonly reason: TerminalFailureReason;
  readonly runId: string;
}

export interface TerminalJobRecord extends QueueJobIdentity {
  readonly attempts: number;
  readonly errorCode: string;
  readonly failedAt: number;
  readonly name: string;
  readonly reason: TerminalFailureReason;
  readonly runId: string;
}

export interface QueueMetrics {
  readonly depth: number;
  readonly failedAttempts: number;
  readonly inFlight: number;
  readonly oldestInFlightAgeMs: number | undefined;
  readonly oldestPendingAgeMs: number | undefined;
  readonly retriesScheduled: number;
  readonly succeeded: number;
  readonly terminalFailures: number;
}

export type EnqueueResult =
  | { readonly jobId: string; readonly status: "enqueued" }
  | { readonly jobId: string; readonly status: "duplicate" };

/**
 * Provider-neutral queue port. Implementations must make state transitions
 * atomic and must keep `jobId` unique across pending and completed work.
 */
export interface Queue<Payload> {
  acknowledge(delivery: QueueDelivery<Payload>): Promise<void>;
  enqueue(job: EnqueueJob<Payload>): Promise<EnqueueResult>;
  moveToTerminal(
    delivery: QueueDelivery<Payload>,
    options: TerminalJobOptions,
  ): Promise<void>;
  retry(
    delivery: QueueDelivery<Payload>,
    options: RetryJobOptions,
  ): Promise<void>;
  snapshot(now: number): Promise<QueueMetrics>;
  take(now: number): Promise<QueueDelivery<Payload> | undefined>;
  terminalFailures(): Promise<readonly TerminalJobRecord[]>;
}
