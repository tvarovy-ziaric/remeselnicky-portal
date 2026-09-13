import type { StructuredLogger } from "@portal/observability";
import type { JobProcessResult, QueueWorker } from "@portal/queue";
import type { QueueTelemetryEvent, QueueTelemetrySink } from "@portal/queue";

export interface WorkerLoopOptions {
  readonly pollIntervalMs?: number;
  readonly processor: QueueWorker;
  readonly signal: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createWorkerQueueTelemetrySink(
  logger: StructuredLogger,
): QueueTelemetrySink {
  return Object.freeze({
    record(event: QueueTelemetryEvent): void {
      const fields = { ...event };
      if (event.type === "job_terminal_failure") {
        logger.error(event.type, fields);
      } else if (event.type === "job_retry_scheduled") {
        logger.warn(event.type, fields);
      } else {
        logger.info(event.type, fields);
      }
    },
  });
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const sleep = options.sleep ?? abortableSleep;

  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError("pollIntervalMs must be a positive safe integer");
  }

  while (!options.signal.aborted) {
    const result: JobProcessResult = await options.processor.processNext();
    if (result.status === "idle" && !options.signal.aborted) {
      await sleep(pollIntervalMs, options.signal);
    }
  }
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
