import { randomUUID } from "node:crypto";

import { loadServerConfig } from "@portal/config/server";
import {
  createCentralErrorTracker,
  createLoggerErrorTransport,
  createStreamDestination,
  createStructuredLogger,
} from "@portal/observability";
import {
  createQueueWorker,
  InMemoryQueue,
  NonRetryableJobError,
} from "@portal/queue";

import { createWorkerQueueTelemetrySink, runWorkerLoop } from "./service.js";
import { runWorker } from "./worker.js";

const config = loadServerConfig();
const result = runWorker(config.observability);
const observabilityContext = {
  ...config.observability,
  service: "worker",
} as const;
const logger = createStructuredLogger({
  context: observabilityContext,
  destination: createStreamDestination(process.stdout),
});
const errorTracker = createCentralErrorTracker({
  context: observabilityContext,
  transport: createLoggerErrorTransport(logger),
});
const abortController = new AbortController();
const queue = new InMemoryQueue<Readonly<Record<string, unknown>>>();
const processor = createQueueWorker({
  backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
  createRunId: randomUUID,
  handler: () =>
    Promise.reject(new NonRetryableJobError("UNREGISTERED_JOB_TYPE")),
  queue,
  telemetry: createWorkerQueueTelemetrySink(logger),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abortController.abort());
}

logger.info("worker_started", { ...result });
try {
  await runWorkerLoop({ processor, signal: abortController.signal });
} catch (error: unknown) {
  errorTracker.capture(error, { mechanism: "worker" });
  process.exitCode = 1;
}
