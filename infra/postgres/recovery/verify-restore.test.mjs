import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RecoveryValidationError,
  parseConfiguration,
  parseTombstoneAttestation,
  runRestoreVerification,
} from "./verify-restore.mjs";

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "portal-recovery-test-"));
  const archive = join(directory, "backup.dump");
  writeFileSync(archive, "fake custom archive");
  return {
    RECOVERY_EXPECTED_ENVIRONMENT: "staging",
    RECOVERY_DATA_CLASS: "synthetic",
    RECOVERY_TARGET_DATABASE: "portal_restore_verify_20260914_a",
    RECOVERY_RUN_ID: "restore-20260914-a",
    RECOVERY_ACKNOWLEDGEMENT: "CREATE_NEW_ISOLATED_DATABASE_ONLY",
    RECOVERY_EXPECTED_MIGRATION_VERSION: "2",
    RECOVERY_SOURCE_ARCHIVE: archive,
    RECOVERY_EVIDENCE_DIRECTORY: join(directory, "evidence"),
    RECOVERY_ADMIN_DATABASE_URL:
      "postgresql://restore_user:secret@staging-db.internal:5432/postgres?sslmode=verify-full",
    RECOVERY_TARGET_DATABASE_URL:
      "postgresql://restore_user:secret@staging-db.internal:5432/portal_restore_verify_20260914_a?sslmode=verify-full",
    ...overrides,
  };
}

function expectCode(environment, code) {
  assert.throws(
    () => parseConfiguration(environment),
    (error) => error instanceof RecoveryValidationError && error.code === code,
  );
}

function productionFixture(overrides = {}) {
  const environment = fixture({
    RECOVERY_EXPECTED_ENVIRONMENT: "recovery",
    RECOVERY_DATA_CLASS: "production",
  });
  const directory = join(
    environment.RECOVERY_EVIDENCE_DIRECTORY,
    "production-inputs",
  );
  mkdirSync(directory, { recursive: true });
  const ledger = join(directory, "normalized-ledger.jsonl");
  const ledgerContent = `${JSON.stringify({
    ledgerCode: "synthetic.ledger",
    recordCount: 0,
    recordType: "PORTAL_PRIVACY_RECOVERY_LEDGER",
    schemaVersion: 1,
  })}\n`;
  writeFileSync(ledger, ledgerContent);
  const reapplicator = join(directory, "reapply-hook");
  writeFileSync(reapplicator, "#!/usr/bin/env node\n", { mode: 0o700 });
  return {
    ...environment,
    RECOVERY_TOMBSTONE_LEDGER: ledger,
    RECOVERY_TOMBSTONE_LEDGER_SHA256: createHash("sha256")
      .update(ledgerContent)
      .digest("hex"),
    RECOVERY_TOMBSTONE_REAPPLICATOR: reapplicator,
    ...overrides,
  };
}

test("accepts an isolated synthetic staging restore", () => {
  const configuration = parseConfiguration(fixture());
  assert.equal(configuration.expectedEnvironment, "staging");
  assert.equal(
    configuration.targetDatabase,
    "portal_restore_verify_20260914_a",
  );
});

test("rejects an existing application-like target name", () => {
  expectCode(
    fixture({ RECOVERY_TARGET_DATABASE: "portal" }),
    "UNSAFE_TARGET_DATABASE",
  );
});

test("rejects production as a verification destination", () => {
  expectCode(
    fixture({ RECOVERY_EXPECTED_ENVIRONMENT: "production" }),
    "UNSAFE_ENVIRONMENT",
  );
});

test("rejects production personal data in staging", () => {
  expectCode(
    fixture({ RECOVERY_DATA_CLASS: "production" }),
    "PRODUCTION_DATA_IN_STAGING",
  );
});

test("requires an exact destructive-action acknowledgement", () => {
  expectCode(
    fixture({ RECOVERY_ACKNOWLEDGEMENT: "yes" }),
    "ACKNOWLEDGEMENT_REQUIRED",
  );
});

test("rejects a target URL that points to a different database", () => {
  expectCode(
    fixture({
      RECOVERY_TARGET_DATABASE_URL:
        "postgresql://restore_user:secret@staging-db.internal:5432/portal?sslmode=verify-full",
    }),
    "TARGET_URL_MISMATCH",
  );
});

test("rejects a target URL on a different server", () => {
  expectCode(
    fixture({
      RECOVERY_TARGET_DATABASE_URL:
        "postgresql://restore_user:secret@production-db.internal:5432/portal_restore_verify_20260914_a?sslmode=verify-full",
    }),
    "TARGET_SERVER_MISMATCH",
  );
});

test("rejects unsupported connection parameters instead of silently weakening TLS", () => {
  expectCode(
    fixture({
      RECOVERY_TARGET_DATABASE_URL:
        "postgresql://restore_user:secret@staging-db.internal:5432/portal_restore_verify_20260914_a?sslmode=verify-full&application_name=test",
    }),
    "UNSUPPORTED_DATABASE_PARAMETER",
  );
});

test("production-class recovery fails closed without a tombstone reapplicator", () => {
  expectCode(
    fixture({
      RECOVERY_EXPECTED_ENVIRONMENT: "recovery",
      RECOVERY_DATA_CLASS: "production",
    }),
    "TOMBSTONE_REAPPLICATION_REQUIRED",
  );
});

test("rejects an invalid normalized-ledger digest", () => {
  expectCode(
    productionFixture({ RECOVERY_TOMBSTONE_LEDGER_SHA256: "not-a-digest" }),
    "INVALID_TOMBSTONE_LEDGER_DIGEST",
  );
});

test("validates exact content-free tombstone attestations", () => {
  const value = {
    database: "portal_restore_verify_20260914_a",
    ledgerSha256: "a".repeat(64),
    recordsAlreadyApplied: 1,
    recordsApplied: 2,
    recordsRead: 3,
    runId: "restore-20260914-a",
    schemaVersion: 1,
    state: "COMPLETED",
  };
  assert.deepEqual(
    parseTombstoneAttestation(JSON.stringify(value), {
      ledgerSha256: "a".repeat(64),
      runId: "restore-20260914-a",
      targetDatabase: "portal_restore_verify_20260914_a",
    }),
    value,
  );
  assert.throws(
    () =>
      parseTombstoneAttestation(JSON.stringify({ ...value, recordsRead: 4 }), {
        ledgerSha256: "a".repeat(64),
        runId: "restore-20260914-a",
        targetDatabase: "portal_restore_verify_20260914_a",
      }),
    (error) =>
      error instanceof RecoveryValidationError &&
      error.code === "TOMBSTONE_ATTESTATION_MISMATCH",
  );
});

test("rejects duplicate TLS parameters", () => {
  expectCode(
    fixture({
      RECOVERY_TARGET_DATABASE_URL:
        "postgresql://restore_user:secret@staging-db.internal:5432/portal_restore_verify_20260914_a?sslmode=verify-full&sslmode=require",
    }),
    "DUPLICATE_DATABASE_PARAMETER",
  );
});

test("executes a guarded restore and writes privacy-safe pass evidence", async () => {
  const environment = fixture();
  const calls = [];
  let queryNumber = 0;

  await runRestoreVerification(environment, {
    output: () => undefined,
    run(binary, args, childEnvironment) {
      calls.push({ binary, args, childEnvironment });
      assert.equal(
        args.some((argument) => argument.includes("secret")),
        false,
      );
      if (binary !== "psql") {
        return "";
      }
      queryNumber += 1;
      if (queryNumber === 1 || queryNumber === 3) {
        return "staging";
      }
      if (queryNumber === 2) {
        return "0";
      }
      return JSON.stringify({
        database: "portal_restore_verify_20260914_a",
        environment: "staging",
        postgis: true,
        migrationLedger: true,
        latestMigration: 2,
        usersTable: true,
      });
    },
  });

  assert.deepEqual(
    calls.map(({ binary }) => binary),
    ["pg_restore", "psql", "psql", "createdb", "psql", "pg_restore", "psql"],
  );
  for (const call of calls.filter(({ binary }) => binary !== "pg_restore")) {
    assert.equal(call.childEnvironment.PGOPTIONS, undefined);
    assert.equal(call.childEnvironment.PGSERVICE, undefined);
  }
  const evidence = JSON.parse(
    readFileSync(
      join(environment.RECOVERY_EVIDENCE_DIRECTORY, "restore-20260914-a.json"),
      "utf8",
    ),
  );
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.containsCredentialsOrPersonalData, false);
  assert.equal(JSON.stringify(evidence).includes("secret"), false);
});

test("production-class restore requires matching hook and database replay attestations", async () => {
  const environment = productionFixture();
  const attestation = {
    database: environment.RECOVERY_TARGET_DATABASE,
    ledgerSha256: environment.RECOVERY_TOMBSTONE_LEDGER_SHA256,
    recordsAlreadyApplied: 0,
    recordsApplied: 0,
    recordsRead: 0,
    runId: environment.RECOVERY_RUN_ID,
    schemaVersion: 1,
    state: "COMPLETED",
  };
  let queryNumber = 0;
  await runRestoreVerification(environment, {
    output: () => undefined,
    run(binary) {
      if (binary === environment.RECOVERY_TOMBSTONE_REAPPLICATOR)
        return JSON.stringify(attestation);
      if (binary !== "psql") return "";
      queryNumber += 1;
      if (queryNumber === 1 || queryNumber === 3) return "recovery";
      if (queryNumber === 2) return "0";
      if (queryNumber === 4) return JSON.stringify(attestation);
      return JSON.stringify({
        database: environment.RECOVERY_TARGET_DATABASE,
        environment: "recovery",
        latestMigration: 2,
        migrationLedger: true,
        postgis: true,
        usersTable: true,
      });
    },
  });
  const evidence = JSON.parse(
    readFileSync(
      join(environment.RECOVERY_EVIDENCE_DIRECTORY, "restore-20260914-a.json"),
      "utf8",
    ),
  );
  assert.deepEqual(evidence.tombstoneState, {
    ledgerSha256: environment.RECOVERY_TOMBSTONE_LEDGER_SHA256,
    recordsAlreadyApplied: 0,
    recordsApplied: 0,
    recordsRead: 0,
    status: "reapplied-and-database-attested",
  });
  assert.equal(evidence.containsCredentialsOrPersonalData, false);
});

test("production recovery rejects a successful no-op hook without attestation", async () => {
  const environment = productionFixture({
    RECOVERY_RUN_ID: "restore-noop-01",
  });
  let queryNumber = 0;
  await assert.rejects(
    runRestoreVerification(environment, {
      output: () => undefined,
      run(binary) {
        if (binary === environment.RECOVERY_TOMBSTONE_REAPPLICATOR) return "";
        if (binary !== "psql") return "";
        queryNumber += 1;
        if (queryNumber === 1 || queryNumber === 3) return "recovery";
        if (queryNumber === 2) return "0";
        return "";
      },
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      error.code === "TOMBSTONE_ATTESTATION_INVALID",
  );
});

test("refuses to overwrite an existing evidence record before running commands", async () => {
  const environment = fixture();
  const evidenceFile = join(
    environment.RECOVERY_EVIDENCE_DIRECTORY,
    `${environment.RECOVERY_RUN_ID}.json`,
  );
  mkdirSync(environment.RECOVERY_EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(evidenceFile, "existing evidence");
  let commandRan = false;

  await assert.rejects(
    runRestoreVerification(environment, {
      run() {
        commandRan = true;
        return "";
      },
    }),
    (error) =>
      error instanceof RecoveryValidationError &&
      error.code === "EVIDENCE_ALREADY_EXISTS",
  );
  assert.equal(commandRan, false);
});
