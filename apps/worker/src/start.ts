import { loadServerConfig } from "@portal/config/server";
import { createDatabase } from "@portal/db";
import {
  createNotificationOutboxPublisher,
  mapJobInvitationNotificationEvent,
} from "@portal/notifications";
import {
  createCentralErrorTracker,
  createLoggerErrorTransport,
  createMonitoringServer,
  createPortalMetrics,
  createStreamDestination,
  createStructuredLogger,
} from "@portal/observability";
import { createOutboxWorker } from "@portal/outbox";

import { createInvitationNotificationProcessor } from "./notification-delivery.js";
import { createWorkerReadiness, runWorkerLoop } from "./service.js";
import { runWorker } from "./worker.js";

const config = loadServerConfig();
const result = runWorker(config.observability);
const database = createDatabase({
  connectionString: config.secrets.databaseUrl,
});
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
const notificationPublisher = createNotificationOutboxPublisher({
  claims: database.outbox.consumerClaims,
  mapper: mapJobInvitationNotificationEvent,
  notifications: database.notifications.writer,
  transactions: database.outbox.transactions,
});
const outboxWorker = createOutboxWorker({
  backoffMs: (attempt) => Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
  leaseDurationMs: 60_000,
  maxAttempts: 10,
  publisher: notificationPublisher,
  store: database.outbox,
  telemetry: {
    record(event) {
      const fields = {
        attempt: event.attempt,
        errorCode: event.errorCode,
        eventId: event.eventId,
        eventName: event.eventName,
        outcome: event.outcome,
      };
      if (event.outcome === "TERMINAL_FAILURE") {
        logger.error("outbox_terminal_failure", fields);
      } else if (event.outcome === "RETRY_SCHEDULED") {
        logger.warn("outbox_retry_scheduled", fields);
      } else {
        logger.info("outbox_published", fields);
      }
    },
  },
});
const processor = createInvitationNotificationProcessor({
  invitations: database.jobInvitations,
  outbox: outboxWorker,
  reminders: database.jobInvitationReminders,
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
    signal: abortController.signal,
  });
} catch (error: unknown) {
  errorTracker.capture(error, { mechanism: "worker" });
  process.exitCode = 1;
} finally {
  readiness.stop();
  metrics.setWorkerReady(false);
  await monitoringServer.close();
  await database.close();
}
