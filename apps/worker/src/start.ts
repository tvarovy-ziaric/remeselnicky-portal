import { runWorker } from "./worker.js";

const result = runWorker();

process.stdout.write(`${JSON.stringify(result)}\n`);
