import { loadServerConfig } from "@portal/config/server";
import { createDatabase } from "@portal/db";
import {
  createCustomerProfileService,
  createCustomerShortlistService,
} from "@portal/domain";
import { createPublicPortfolioDeliveryResolver } from "@portal/media";
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

import { buildApi } from "./app.js";
import {
  createAuthPersistence,
  createEmailVerificationPersistence,
  createPhoneVerificationPersistence,
} from "./auth/index.js";
import { createDatabaseFrontendErrorAdmission } from "./observability.js";

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
const publicSearchCards = createPublicSearchCardSearch(
  database.publicSearchCards,
);

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
    persistence: authPersistence,
  },
  database,
  publicCraftsmanProfiles: { profiles: database.publicCraftsmanProfiles },
  publicPortfolioMedia: {
    delivery: createPublicPortfolioDeliveryResolver({
      repository: database.publicPortfolioDelivery,
    }),
  },
  publicSearchCards: { searchCards: publicSearchCards },
  taxonomyAutocomplete: {
    autocomplete: createTaxonomyAutocompleteService(
      database.taxonomyAutocomplete,
    ),
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
