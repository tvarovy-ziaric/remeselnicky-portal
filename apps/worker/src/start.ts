import { loadServerConfig } from "@portal/config/server";
import {
  createNoopAnalyticsTransport,
  createR3AnalyticsProcessor,
  createTrustedAnalyticsPublisher,
} from "@portal/analytics";
import { createDatabase } from "@portal/db";
import {
  createClamdMalwareScanner,
  createDocumentValidationQueueHandler,
  createImageCanonicalizationQueueHandler,
} from "@portal/media";
import {
  createNotificationOutboxPublisher,
  mapDemandSideNotificationEvent,
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
import {
  createObjectStorageService,
  createS3CompatibleObjectStorageAdapter,
  defineStorageTopology,
} from "@portal/storage";

import { createMediaProcessingWorker } from "./media-processing.js";
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
  mapper: mapDemandSideNotificationEvent,
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
const analyticsPublisher = createTrustedAnalyticsPublisher({
  appVersion: config.releaseRevision,
  environment: config.environment,
  platform: "WEB",
  transport: createNoopAnalyticsTransport(config.environment),
});
const analyticsProcessor = createR3AnalyticsProcessor({
  backoffMs: (attempt) => Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
  leaseDurationMs: 60_000,
  publisher: analyticsPublisher,
  store: database.r3Analytics,
});
const mediaProcessing = createMediaRuntime();
const processor = createInvitationNotificationProcessor({
  analytics: analyticsProcessor,
  demandSideNotifications: database.demandSideNotifications,
  invitations: database.jobInvitations,
  ...(mediaProcessing === undefined ? {} : { mediaProcessing }),
  outbox: outboxWorker,
  onAnalyticsError(error) {
    errorTracker.capture(error, { handled: true, mechanism: "worker" });
  },
  quotes: database.quoteLifecycle,
  reminders: database.jobInvitationReminders,
});

function createMediaRuntime() {
  const storageConfig = config.objectStorage;
  const storageSecrets = config.secrets.storage;
  const scannerConfig = config.malwareScanner;
  if (
    storageConfig === undefined ||
    storageSecrets === undefined ||
    scannerConfig === undefined
  ) {
    if (
      config.environment === "staging" ||
      config.environment === "production"
    ) {
      throw new Error(
        "Media processing runtime is required outside development",
      );
    }
    return undefined;
  }
  const storage = createObjectStorageService({
    adapter: createS3CompatibleObjectStorageAdapter({
      accessKeyId: storageSecrets.accessKeyId,
      endpoint: storageConfig.endpoint,
      forcePathStyle: storageConfig.forcePathStyle,
      publicBaseUrl: storageConfig.publicBaseUrl,
      region: storageConfig.region,
      secretAccessKey: storageSecrets.secretAccessKey,
      ...(storageConfig.signingEndpoint === undefined
        ? {}
        : { signingEndpoint: storageConfig.signingEndpoint }),
    }),
    topology: defineStorageTopology({
      privateContainer: storageConfig.privateContainer,
      publicDerivativeContainer: storageConfig.publicDerivativeContainer,
    }),
  });
  const orphanedObjectObserver = Object.freeze({
    recordOrphanedPrivateObject(input: {
      readonly reason: string;
      readonly storageObject: Readonly<{ readonly area: string }>;
    }): void {
      logger.error("orphaned_private_media_object", {
        reason: input.reason,
        storageArea: input.storageObject.area,
      });
    },
  });
  return createMediaProcessingWorker({
    document: createDocumentValidationQueueHandler({
      environment: config.environment,
      orphanedObjectObserver,
      repository: database.media,
      scanner: createClamdMalwareScanner(scannerConfig),
      storage,
    }),
    image: createImageCanonicalizationQueueHandler({
      orphanedObjectObserver,
      repository: database.media,
      storage,
    }),
    queue: database.mediaProcessingQueue,
  });
}

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
