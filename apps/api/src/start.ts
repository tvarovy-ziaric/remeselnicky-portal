import { loadServerConfig } from "@portal/config/server";
import { createDatabase } from "@portal/db";
import {
  createCustomerProfileService,
  createCustomerShortlistService,
  createConversationChatService,
  createJobRequestDraftService,
  createJobRequestService,
  createJobRequestLifecycleService,
  createJobRequestVersionService,
  createQuoteService,
  createStructuredQuoteService,
} from "@portal/domain";
import {
  createControlledMediaUploadService,
  createConversationAttachmentUploadService,
  createJobRequestMediaUploadService,
  createMediaProcessingDispatcher,
  createPrivateMediaDeliveryService,
  createPublicPortfolioDeliveryResolver,
  createPurposeBoundMediaEntityAccessResolver,
  createQuoteDocumentUploadService,
} from "@portal/media";
import {
  createCentralErrorTracker,
  createLoggerErrorTransport,
  createMonitoringServer,
  createPortalMetrics,
  createStreamDestination,
  createStructuredLogger,
} from "@portal/observability";
import {
  createPublicSearchCardSearch,
  createTaxonomyAutocompleteService,
} from "@portal/search";
import {
  createObjectStorageService,
  createS3CompatibleObjectStorageAdapter,
  defineStorageTopology,
} from "@portal/storage";

import { buildApi } from "./app.js";
import {
  createAuthPersistence,
  createEmailVerificationPersistence,
  createPhoneVerificationPersistence,
} from "./auth/index.js";
import { createDatabaseFrontendErrorAdmission } from "./observability.js";
import { createDatabaseConversationWriteAdmission } from "./conversations/write-admission.js";
import {
  createDatabasePublicSearchAdmission,
  PUBLIC_SEARCH_RATE_LIMIT_MULTIPLIER,
} from "./public-search-cards/routes.js";

const defaultPort = 3_001;
const config = loadServerConfig();
const port = config.port ?? defaultPort;
const database = createDatabase({
  connectionString: config.secrets.databaseUrl,
});
const authPersistence = createAuthPersistence(database.auth);
const observabilityContext = {
  ...config.observability,
  service: "api",
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
const monitoringServer = createMonitoringServer({ metrics });
const customerShortlist = createCustomerShortlistService({
  customerProfiles: createCustomerProfileService({
    persistence: database.customerProfiles,
  }),
  persistence: database.customerShortlist,
});
const customerProfiles = createCustomerProfileService({
  persistence: database.customerProfiles,
});
const jobRequestDrafts = createJobRequestDraftService({
  persistence: database.jobRequestDrafts,
});
const jobRequests = createJobRequestService({
  customerProfiles,
  persistence: database.jobRequests,
});
const jobRequestVersions = createJobRequestVersionService({
  persistence: database.jobRequestVersions,
});
const jobRequestLifecycle = createJobRequestLifecycleService({
  persistence: database.jobRequestLifecycle,
});
const publicSearchCards = createPublicSearchCardSearch(
  database.publicSearchCards,
);
const publicDiscoveryAdmission = createDatabasePublicSearchAdmission({
  limit: config.auth.rateLimitMax * PUBLIC_SEARCH_RATE_LIMIT_MULTIPLIER,
  persistence: authPersistence,
  timeWindowMs: config.auth.rateLimitWindowMs,
});
const conversationChat = createConversationChatService({
  persistence: database.conversationChat,
});
const conversationWriteAdmission = createDatabaseConversationWriteAdmission({
  accountLimit: config.auth.rateLimitMax,
  persistence: authPersistence,
  timeWindowMs: config.auth.rateLimitWindowMs,
});
const quoteAuthoring = createQuoteService({ persistence: database.quotes });
const structuredQuoteAuthoring = createStructuredQuoteService({
  persistence: database.structuredQuotes,
});
const mediaRuntime = createApiMediaRuntime();

const app = buildApi({
  auth: {
    config: {
      appOrigin: config.appOrigin,
      ...config.auth,
      sessionSecret: config.secrets.sessionSecret,
    },
    emailVerification: {
      persistence: createEmailVerificationPersistence(
        database.emailVerification,
      ),
    },
    phoneVerification: {
      persistence: createPhoneVerificationPersistence(
        database.phoneVerification,
      ),
    },
    customerShortlist: { shortlist: customerShortlist },
    draftHandoff: {
      customerProfiles,
      drafts: database.jobRequestDrafts,
    },
    jobRequestDrafts: {
      customerProfiles,
      draftPersistence: database.jobRequestDrafts,
      drafts: jobRequestDrafts,
      ...(mediaRuntime === undefined
        ? {}
        : { mediaUploads: mediaRuntime.jobRequestUploads }),
      requests: jobRequests,
    },
    jobRequestVersions: { versions: jobRequestVersions },
    jobRequestLifecycle: { lifecycle: jobRequestLifecycle },
    jobInvitations: { invitations: database.jobInvitations },
    conversations: { conversations: database.conversations },
    quoteComparison: { comparison: database.quoteComparison },
    quoteLifecycle: { lifecycle: database.quoteLifecycle },
    quoteAuthoring: {
      core: quoteAuthoring,
      ...(mediaRuntime === undefined
        ? {}
        : { documentUploads: mediaRuntime.quoteDocumentUploads }),
      externalPdf: database.externalPdfQuotes,
      structured: structuredQuoteAuthoring,
    },
    r3Analytics: { observations: database.r3AnalyticsObservations },
    conversationChat: {
      admission: conversationWriteAdmission,
      ...(mediaRuntime === undefined
        ? {}
        : {
            attachmentUploads: mediaRuntime.conversationAttachmentUploads,
          }),
      pdfDeliveryObservation: database.r3PdfDeliveryObservations,
      persistence: database.conversationChat,
      ...(mediaRuntime === undefined
        ? {}
        : { privateMediaDelivery: mediaRuntime.privateMediaDelivery }),
      service: conversationChat,
    },
    persistence: authPersistence,
  },
  database,
  publicCraftsmanProfiles: { profiles: database.publicCraftsmanProfiles },
  publicPortfolioMedia: {
    delivery: createPublicPortfolioDeliveryResolver({
      repository: database.publicPortfolioDelivery,
    }),
  },
  publicSearchCards: {
    admission: publicDiscoveryAdmission,
    searchCards: publicSearchCards,
  },
  taxonomyAutocomplete: {
    autocomplete: createTaxonomyAutocompleteService(
      database.taxonomyAutocomplete,
    ),
  },
  municipalityAutocomplete: {
    admission: publicDiscoveryAdmission,
    municipalities: database.municipalityAutocomplete,
  },
  observability: {
    appOrigin: config.appOrigin,
    context: config.observability,
    errorTracker,
    frontendErrorAdmission: createDatabaseFrontendErrorAdmission({
      limit: config.auth.rateLimitMax * 5,
      persistence: authPersistence,
      timeWindowMs: config.auth.rateLimitWindowMs,
    }),
    logger,
    metrics,
  },
});

function createApiMediaRuntime() {
  const storageConfig = config.objectStorage;
  const storageSecrets = config.secrets.storage;
  if (storageConfig === undefined || storageSecrets === undefined) {
    if (
      config.environment === "staging" ||
      config.environment === "production"
    ) {
      throw new Error("Private media runtime is required outside development");
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
  const uploads = createControlledMediaUploadService({
    orphanedObjectObserver,
    repository: database.media,
    storage,
  });
  const processing = createMediaProcessingDispatcher(
    database.mediaProcessingQueue,
  );
  const privateMediaDelivery = createPrivateMediaDeliveryService({
    applicationOrigin: config.appOrigin,
    entityAccess: createPurposeBoundMediaEntityAccessResolver({
      byPurpose: {
        CHAT_DOCUMENT: database.conversationAttachmentMediaAccess,
        CHAT_IMAGE: database.conversationAttachmentMediaAccess,
        JOB_REQUEST_DOCUMENT: database.jobRequestMediaAccess,
        JOB_REQUEST_IMAGE: database.jobRequestMediaAccess,
        QUOTE_DOCUMENT: database.quoteDocumentMediaAccess,
      },
    }),
    repository: database.privateMediaDelivery,
    storage,
  });
  return Object.freeze({
    conversationAttachmentUploads: createConversationAttachmentUploadService({
      authorization: database.conversationAttachmentUploads,
      processing,
      uploads,
    }),
    jobRequestUploads: createJobRequestMediaUploadService({
      authorization: database.jobRequestMedia,
      processing,
      uploads,
    }),
    privateMediaDelivery,
    quoteDocumentUploads: createQuoteDocumentUploadService({
      authorization: database.quoteDocumentUploads,
      processing,
      uploads,
    }),
  });
}
app.addHook("onClose", async () => {
  await monitoringServer.close();
  await database.close();
});

try {
  await monitoringServer.listen({ host: "0.0.0.0", port: 9_464 });
  await app.listen({ host: "0.0.0.0", port });
} catch (error: unknown) {
  errorTracker.capture(error, { mechanism: "startup" });
  await monitoringServer.close();
  await database.close();
  process.exitCode = 1;
}
