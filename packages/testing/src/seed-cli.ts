import postgres from "postgres";

import { createSyntheticSeedCatalog } from "./fixtures.js";
import { createPostgresSyntheticSeedPersistence } from "./postgres.js";
import { applySyntheticSeedCatalog, parseAllowedEnvironment } from "./seed.js";

async function main(): Promise<void> {
  // Reject production/unknown execution before a connection or credential read.
  const environment = parseAllowedEnvironment(process.env["APP_ENV"]);
  const databaseUrl = requiredEnvironmentValue("DATABASE_URL");
  const passwordHash = requiredEnvironmentValue("SYNTHETIC_SEED_PASSWORD_HASH");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const report = await applySyntheticSeedCatalog({
      catalog: createSyntheticSeedCatalog(),
      credentialHashes: {
        kind: "TEST_ONLY_HASH_PROVIDER",
        passwordHashFor: () => Promise.resolve(passwordHash),
      },
      environment,
      persistence: createPostgresSyntheticSeedPersistence(sql),
    });
    process.stdout.write(
      `${JSON.stringify({ ...report, dataClass: "synthetic" })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for synthetic seed execution.`);
  }
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeFailureMessage(error)}\n`);
  process.exitCode = 1;
});

function safeFailureMessage(error: unknown): string {
  if (!(error instanceof Error))
    return "Synthetic seed execution failed safely.";
  const safeMessages = [
    "Synthetic seed execution is allowed only",
    "Database environment marker does not match",
    "Existing identity conflicts",
    "Injected password hash must",
    "Only a versioned synthetic seed catalog",
    "Synthetic seeds require an explicit",
  ];
  if (
    safeMessages.some((prefix) => error.message.startsWith(prefix)) ||
    /^[A-Z][A-Z0-9_]+ is required for synthetic seed execution\.$/u.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "Synthetic seed execution failed safely.";
}
