import { randomUUID } from "node:crypto";

import { loadServerConfig } from "@portal/config/server";
import {
  createCentralErrorTracker,
  createLoggerErrorTransport,
  createMonitoringServer,
  createPortalMetrics,
  createStreamDestination,
  createStructuredLogger,
} from "@portal/observability";
import {
  createQueueWorker,
  InMemoryQueue,
  NonRetryableJobError,
} from "@portal/queue";

import {
  createWorkerQueueTelemetrySink,
  createWorkerReadiness,
  runWorkerLoop,
} from "./service.js";
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
const metrics = createPortalMetrics(observabilityContext);
const readiness = createWorkerReadiness({ maxHeartbeatAgeMs: 30_000 });
const monitoringServer = createMonitoringServer({
  metrics,
  ready: () => {
    const ready = readiness.isReady();
    metrics.setWorkerReady(ready);
    return ready;
  },
});
const abortController = new AbortController();
const queue = new InMemoryQueue<Readonly<Record<string, unknown>>>();
const processor = createQueueWorker({
  backoff: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
  createRunId: randomUUID,
  handler: () =>
    Promise.reject(new NonRetryableJobError("UNREGISTERED_JOB_TYPE")),
  queue,
  telemetry: createWorkerQueueTelemetrySink(logger, metrics),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abortController.abort());
}

logger.info("worker_started", { ...result });
try {
  await monitoringServer.listen({ host: "0.0.0.0", port: 9_465 });
  readiness.heartbeat();
  metrics.setWorkerReady(true);
  await runWorkerLoop({
    heartbeat: () => readiness.heartbeat(),
    metrics,
    processor,
    queueMetrics: queue,
    signal: abortController.signal,
  });
} catch (error: unknown) {
  errorTracker.capture(error, { mechanism: "worker" });
  process.exitCode = 1;
} finally {
  readiness.stop();
  metrics.setWorkerReady(false);
  await monitoringServer.close();
}
