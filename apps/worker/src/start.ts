import { loadServerConfig } from "@portal/config/server";

import { runWorker } from "./worker.js";

const config = loadServerConfig();
const result = runWorker(config.observability);

process.stdout.write(`${JSON.stringify(result)}\n`);
