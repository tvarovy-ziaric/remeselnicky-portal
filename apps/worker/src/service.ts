import type { JobProcessResult, QueueWorker } from "@portal/queue";

export interface WorkerLoopOptions {
  readonly pollIntervalMs?: number;
  readonly processor: QueueWorker;
  readonly signal: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
