import { loadServerConfig } from "@portal/config/server";
import { createDatabase } from "@portal/db";

import { buildApi } from "./app.js";

const defaultPort = 3_001;
const config = loadServerConfig();
const port = config.port ?? defaultPort;
const database = createDatabase({
  connectionString: config.secrets.databaseUrl,
});

const app = buildApi({ database });
app.addHook("onClose", () => database.close());

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error: unknown) {
  app.log.error(error);
  await database.close();
  process.exitCode = 1;
}
