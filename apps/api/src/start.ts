import { loadServerConfig } from "@portal/config/server";

import { buildApi } from "./app.js";

const defaultPort = 3_001;
const config = loadServerConfig();
const port = config.port ?? defaultPort;

const app = buildApi();

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
}
