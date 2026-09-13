import { randomUUID } from "node:crypto";

import { loadServerConfig } from "@portal/config/server";
import {
  createQueueWorker,
  InMemoryQueue,
  NonRetryableJobError,
  type QueueTelemetryEvent,
} from "@portal/queue";

import { runWorkerLoop } from "./service.js";
import { runWorker } from "./worker.js";

const config = loadServerConfig();
const result = runWorker(config.observability);
const abortController = new AbortController();
const queue = new InMemoryQueue<Readonly<Record<string, unknown>>>();
const processor = createQueueWorker({
  backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
  createRunId: randomUUID,
  handler: () =>
    Promise.reject(new NonRetryableJobError("UNREGISTERED_JOB_TYPE")),
  queue,
  telemetry: {
    record(event: QueueTelemetryEvent): void {
      process.stdout.write(
        `${JSON.stringify({
          ...event,
          environment: config.observability.environment,
          level:
            event.type === "job_terminal_failure"
              ? "error"
              : event.type === "job_retry_scheduled"
                ? "warn"
                : "info",
          releaseRevision: config.observability.releaseRevision,
          service: "worker",
          timestamp: new Date(event.occurredAt).toISOString(),
        })}\n`,
      );
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abortController.abort());
}

process.stdout.write(
  `${JSON.stringify({
    ...result,
    event: "worker_started",
    level: "info",
    timestamp: new Date().toISOString(),
  })}\n`,
);
await runWorkerLoop({ processor, signal: abortController.signal });
