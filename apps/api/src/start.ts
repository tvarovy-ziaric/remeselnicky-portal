import { buildApi } from "./app.js";

const defaultPort = 3_001;
const configuredPort = process.env.PORT;
const port =
  configuredPort === undefined ? defaultPort : Number(configuredPort);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = buildApi();

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
}
