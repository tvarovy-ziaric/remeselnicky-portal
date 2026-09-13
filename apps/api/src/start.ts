import { loadServerConfig } from "@portal/config/server";
import { createDatabase } from "@portal/db";

import { buildApi } from "./app.js";
import { createAuthPersistence } from "./auth/index.js";

const defaultPort = 3_001;
const config = loadServerConfig();
const port = config.port ?? defaultPort;
const database = createDatabase({
  connectionString: config.secrets.databaseUrl,
});

const app = buildApi({
  auth: {
    config: {
      appOrigin: config.appOrigin,
      ...config.auth,
      sessionSecret: config.secrets.sessionSecret,
    },
    persistence: createAuthPersistence(database.auth),
  },
  database,
});
app.addHook("onClose", () => database.close());

try {
  await app.listen({ host: "0.0.0.0", port });
} catch {
  app.log.error({ event: "api_start_failed" });
  await database.close();
  process.exitCode = 1;
}
