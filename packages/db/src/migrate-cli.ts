import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { ensureManagedCatalogV1 } from "./managed-catalog-provisioner.js";
import { migratePostgres } from "./migrator.js";

const connectionString = process.env["DATABASE_URL"];
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required to run database migrations.");
}

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationsDirectory = path.join(packageDirectory, "migrations");
const result = await migratePostgres(connectionString, migrationsDirectory);
const sql = postgres(connectionString, { max: 1 });
const catalog = await ensureManagedCatalogV1(sql).finally(() =>
  sql.end({ timeout: 5 }),
);

if (result.applied.length === 0) {
  process.stdout.write(
    `Database is current (${result.alreadyApplied.toString()} migrations).\n`,
  );
} else {
  process.stdout.write(`Applied ${result.applied.join(", ")}.\n`);
}
process.stdout.write(
  `Managed catalog v1 current: release ${catalog.releaseId}, version ${catalog.version.toString()}, ${catalog.professions.toString()} professions, ${catalog.services.toString()} services, ${catalog.aliases.toString()} aliases.\n`,
);
