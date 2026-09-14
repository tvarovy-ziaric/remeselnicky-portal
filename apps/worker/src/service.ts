import type {
  PortalMetrics,
  QueueMetricSnapshot,
  StructuredLogger,
} from "@portal/observability";
import type { JobProcessResult, QueueWorker } from "@portal/queue";
import type { QueueTelemetryEvent, QueueTelemetrySink } from "@portal/queue";

export interface WorkerLoopOptions {
  readonly heartbeat?: () => void;
  readonly metrics?: PortalMetrics;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly processor: QueueWorker;
  readonly queueMetrics?: {
    snapshot(now: number): Promise<QueueMetricSnapshot>;
  };
  readonly signal: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createWorkerQueueTelemetrySink(
  logger: StructuredLogger,
  metrics?: PortalMetrics,
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
      try {
        metrics?.recordQueueEvent(event.type);
      } catch {
        // Metrics delivery must not change queue processing.
      }
    },
  });
}

export interface WorkerReadiness {
  heartbeat(): void;
  isReady(): boolean;
  stop(): void;
}

export function createWorkerReadiness(input: {
  readonly clock?: () => number;
  readonly maxHeartbeatAgeMs: number;
}): WorkerReadiness {
  if (
    !Number.isSafeInteger(input.maxHeartbeatAgeMs) ||
    input.maxHeartbeatAgeMs < 1
  ) {
    throw new RangeError("maxHeartbeatAgeMs must be a positive safe integer");
  }
  const clock = input.clock ?? Date.now;
  let lastHeartbeat: number | undefined;
  return Object.freeze({
    heartbeat(): void {
      lastHeartbeat = clock();
    },
    isReady(): boolean {
      return (
        lastHeartbeat !== undefined &&
        Math.max(0, clock() - lastHeartbeat) <= input.maxHeartbeatAgeMs
      );
    },
    stop(): void {
      lastHeartbeat = undefined;
    },
  });
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;

  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError("pollIntervalMs must be a positive safe integer");
  }

  while (!options.signal.aborted) {
    options.heartbeat?.();
    const result: JobProcessResult = await options.processor.processNext();
    options.heartbeat?.();
    if (options.queueMetrics !== undefined && options.metrics !== undefined) {
      try {
        options.metrics.setQueueSnapshot(
          await options.queueMetrics.snapshot(now()),
        );
      } catch {
        // A scrape snapshot is best effort and cannot fail queue processing.
      }
    }
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
