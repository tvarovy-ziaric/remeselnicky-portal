import { randomUUID } from "node:crypto";

import {
  exponentialBackoff,
  type ExponentialBackoffOptions,
} from "./backoff.js";
import type {
  Queue,
  QueueDelivery,
  QueueJobIdentity,
  TerminalFailureReason,
} from "./contracts.js";
import { classifyJobError } from "./errors.js";

export interface JobRunContext extends QueueJobIdentity {
  readonly attempt: number;
  readonly runId: string;
}

export type QueueHandler<Payload> = (
  payload: Payload,
  context: JobRunContext,
) => Promise<void>;

interface QueueTelemetryBase extends JobRunContext {
  readonly jobName: string;
  readonly occurredAt: number;
}

export type QueueTelemetryEvent =
  | (QueueTelemetryBase & { readonly type: "job_attempt_started" })
  | (QueueTelemetryBase & { readonly type: "job_attempt_succeeded" })
  | (QueueTelemetryBase & {
      readonly delayMs: number;
      readonly errorCode: string;
      readonly type: "job_retry_scheduled";
    })
  | (QueueTelemetryBase & {
      readonly errorCode: string;
      readonly reason: TerminalFailureReason;
      readonly type: "job_terminal_failure";
    });

export interface QueueTelemetrySink {
  /** Events deliberately contain identifiers and outcome metadata, never payload. */
  record(event: QueueTelemetryEvent): void;
}

export type JobProcessResult =
  | { readonly status: "idle" }
  | (JobRunContext & { readonly status: "succeeded" })
  | (JobRunContext & {
      readonly availableAt: number;
      readonly status: "retry_scheduled";
    })
  | (JobRunContext & {
      readonly reason: TerminalFailureReason;
      readonly status: "terminal_failure";
    });

export interface QueueWorker {
  processNext(): Promise<JobProcessResult>;
}

export interface CreateQueueWorkerOptions<Payload> {
  readonly backoff: ExponentialBackoffOptions;
  readonly createRunId: () => string;
  readonly handler: QueueHandler<Payload>;
  readonly now?: () => number;
  readonly queue: Queue<Payload>;
  readonly telemetry?: QueueTelemetrySink;
}

export function createQueueWorker<Payload>(
  options: CreateQueueWorkerOptions<Payload>,
): QueueWorker {
  const now = options.now ?? Date.now;

  return Object.freeze({
    async processNext(): Promise<JobProcessResult> {
      const delivery = await options.queue.take(now());
      if (delivery === undefined) return { status: "idle" };

      const contextBase = {
        attempt: delivery.attempt,
        correlationId: delivery.correlationId,
        eventId: delivery.eventId,
        jobId: delivery.jobId,
      };
      let runId: string;
      try {
        runId = requireRunId(options.createRunId());
      } catch {
        const context = Object.freeze({
          ...contextBase,
          runId: `run-fallback-${randomUUID()}`,
        });
        emit(
          options.telemetry,
          telemetryBase("job_attempt_started", delivery, context, now()),
        );
        return handleFailure(
          options,
          delivery,
          context,
          { code: "RUN_ID_GENERATION_FAILED", retryable: true },
          now,
        );
      }
      const context = Object.freeze({ ...contextBase, runId });
      emit(
        options.telemetry,
        telemetryBase("job_attempt_started", delivery, context, now()),
      );

      try {
        await options.handler(delivery.payload, context);
        await options.queue.acknowledge(delivery);
        emit(
          options.telemetry,
          telemetryBase("job_attempt_succeeded", delivery, context, now()),
        );
        return { ...context, status: "succeeded" };
      } catch (error: unknown) {
        return handleFailure(
          options,
          delivery,
          context,
          classifyJobError(error),
          now,
        );
      }
    },
  });
}

async function handleFailure<Payload>(
  options: CreateQueueWorkerOptions<Payload>,
  delivery: QueueDelivery<Payload>,
  context: JobRunContext,
  failure: { readonly code: string; readonly retryable: boolean },
  now: () => number,
): Promise<JobProcessResult> {
  if (!failure.retryable) {
    return moveToTerminal(
      options,
      delivery,
      context,
      failure.code,
      "non_retryable",
      now(),
    );
  }
  if (delivery.attempt >= delivery.maxAttempts) {
    return moveToTerminal(
      options,
      delivery,
      context,
      failure.code,
      "retries_exhausted",
      now(),
    );
  }

  const delayMs = exponentialBackoff(delivery.attempt, options.backoff);
  const availableAt = now() + delayMs;
  await options.queue.retry(delivery, {
    availableAt,
    errorCode: failure.code,
  });
  emit(options.telemetry, {
    ...telemetryBase("job_retry_scheduled", delivery, context, now()),
    delayMs,
    errorCode: failure.code,
  });
  return { ...context, availableAt, status: "retry_scheduled" };
}

async function moveToTerminal<Payload>(
  options: CreateQueueWorkerOptions<Payload>,
  delivery: QueueDelivery<Payload>,
  context: JobRunContext,
  errorCode: string,
  reason: TerminalFailureReason,
  failedAt: number,
): Promise<JobProcessResult> {
  await options.queue.moveToTerminal(delivery, {
    errorCode,
    failedAt,
    reason,
    runId: context.runId,
  });
  emit(options.telemetry, {
    ...telemetryBase("job_terminal_failure", delivery, context, failedAt),
    errorCode,
    reason,
  });
  return { ...context, reason, status: "terminal_failure" };
}

function telemetryBase<Type extends QueueTelemetryEvent["type"], Payload>(
  type: Type,
  delivery: QueueDelivery<Payload>,
  context: JobRunContext,
  occurredAt: number,
): QueueTelemetryBase & { readonly type: Type } {
  return {
    ...context,
    jobName: delivery.name,
    occurredAt,
    type,
  };
}

function emit(
  telemetry: QueueTelemetrySink | undefined,
  event: QueueTelemetryEvent,
): void {
  try {
    telemetry?.record(Object.freeze(event));
  } catch {
    // Telemetry failure must not change queue or business outcomes.
  }
}

function requireRunId(runId: string): string {
  if (runId.trim().length === 0 || runId.length > 128) {
    throw new TypeError(
      "createRunId must return a non-empty bounded identifier",
    );
  }
  return runId;
}
