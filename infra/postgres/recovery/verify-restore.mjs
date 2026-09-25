#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TARGET_DATABASE_PATTERN =
  /^portal_restore_verify_[a-z0-9][a-z0-9_]{5,48}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{5,63}$/;
const ACKNOWLEDGEMENT = "CREATE_NEW_ISOLATED_DATABASE_ONLY";
const ALLOWED_ENVIRONMENTS = new Set(["staging", "recovery"]);
const ALLOWED_DATA_CLASSES = new Set(["synthetic", "anonymized", "production"]);
const URL_PARAMETER_ENV = new Map([
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcert", "PGSSLCERT"],
  ["sslkey", "PGSSLKEY"],
  ["sslcrl", "PGSSLCRL"],
  ["ssl_min_protocol_version", "PGSSLMINPROTOCOLVERSION"],
]);

export class RecoveryValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecoveryValidationError";
    this.code = code;
  }
}

function requireValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new RecoveryValidationError(
      "MISSING_CONFIGURATION",
      `${name} is required.`,
    );
  }
  return value;
}

export function parseConfiguration(environment = process.env) {
  const expectedEnvironment = requireValue(
    environment,
    "RECOVERY_EXPECTED_ENVIRONMENT",
  );
  const dataClass = requireValue(environment, "RECOVERY_DATA_CLASS");
  const targetDatabase = requireValue(environment, "RECOVERY_TARGET_DATABASE");
  const runId = requireValue(environment, "RECOVERY_RUN_ID");

  if (!ALLOWED_ENVIRONMENTS.has(expectedEnvironment)) {
    throw new RecoveryValidationError(
      "UNSAFE_ENVIRONMENT",
      "Restore verification is allowed only in marked staging or isolated recovery environments.",
    );
  }
  if (!ALLOWED_DATA_CLASSES.has(dataClass)) {
    throw new RecoveryValidationError(
      "INVALID_DATA_CLASS",
      "Unsupported recovery data class.",
    );
  }
  if (expectedEnvironment === "staging" && dataClass === "production") {
    throw new RecoveryValidationError(
      "PRODUCTION_DATA_IN_STAGING",
      "Production personal data cannot be restored into staging.",
    );
  }
  if (!TARGET_DATABASE_PATTERN.test(targetDatabase)) {
    throw new RecoveryValidationError(
      "UNSAFE_TARGET_DATABASE",
      "Target database must use the dedicated portal_restore_verify_ prefix.",
    );
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RecoveryValidationError(
      "INVALID_RUN_ID",
      "RECOVERY_RUN_ID has an invalid format.",
    );
  }
  if (environment.RECOVERY_ACKNOWLEDGEMENT !== ACKNOWLEDGEMENT) {
    throw new RecoveryValidationError(
      "ACKNOWLEDGEMENT_REQUIRED",
      `RECOVERY_ACKNOWLEDGEMENT must equal ${ACKNOWLEDGEMENT}.`,
    );
  }

  const expectedMigrationVersionText = requireValue(
    environment,
    "RECOVERY_EXPECTED_MIGRATION_VERSION",
  );
  if (!/^\d+$/.test(expectedMigrationVersionText)) {
    throw new RecoveryValidationError(
      "INVALID_MIGRATION_VERSION",
      "RECOVERY_EXPECTED_MIGRATION_VERSION must be a non-negative integer.",
    );
  }

  const archive = resolve(requireValue(environment, "RECOVERY_SOURCE_ARCHIVE"));
  const evidenceDirectory = resolve(
    requireValue(environment, "RECOVERY_EVIDENCE_DIRECTORY"),
  );
  assertRegularFile(archive, "BACKUP_ARCHIVE_NOT_FOUND");

  const admin = parsePostgresUrl(
    requireValue(environment, "RECOVERY_ADMIN_DATABASE_URL"),
  );
  const target = parsePostgresUrl(
    requireValue(environment, "RECOVERY_TARGET_DATABASE_URL"),
  );
  if (target.database !== targetDatabase) {
    throw new RecoveryValidationError(
      "TARGET_URL_MISMATCH",
      "Target URL database does not match RECOVERY_TARGET_DATABASE.",
    );
  }
  if (connectionIdentity(admin) !== connectionIdentity(target)) {
    throw new RecoveryValidationError(
      "TARGET_SERVER_MISMATCH",
      "Admin and target URLs must use the same server, principal and TLS parameters.",
    );
  }
  if (admin.database === targetDatabase) {
    throw new RecoveryValidationError(
      "ADMIN_TARGET_COLLISION",
      "The maintenance database cannot be the restore target.",
    );
  }

  let tombstoneReapplicator;
  let tombstoneLedger;
  let tombstoneLedgerSha256;
  if (dataClass === "production") {
    if (
      !environment.RECOVERY_TOMBSTONE_REAPPLICATOR?.trim() ||
      !environment.RECOVERY_TOMBSTONE_LEDGER?.trim() ||
      !environment.RECOVERY_TOMBSTONE_LEDGER_SHA256?.trim()
    ) {
      throw new RecoveryValidationError(
        "TOMBSTONE_REAPPLICATION_REQUIRED",
        "Production-class recovery requires the deletion/anonymization reapplication inputs.",
      );
    }
    tombstoneReapplicator = resolve(
      requireValue(environment, "RECOVERY_TOMBSTONE_REAPPLICATOR"),
    );
    tombstoneLedger = resolve(
      requireValue(environment, "RECOVERY_TOMBSTONE_LEDGER"),
    );
    tombstoneLedgerSha256 = requireValue(
      environment,
      "RECOVERY_TOMBSTONE_LEDGER_SHA256",
    );
    if (!/^[0-9a-f]{64}$/.test(tombstoneLedgerSha256)) {
      throw new RecoveryValidationError(
        "INVALID_TOMBSTONE_LEDGER_DIGEST",
        "The normalized tombstone ledger SHA-256 is invalid.",
      );
    }
    assertExecutableFile(tombstoneReapplicator);
    assertRegularFile(tombstoneLedger, "TOMBSTONE_LEDGER_NOT_FOUND");
  }

  const evidenceFile = resolve(evidenceDirectory, `${runId}.json`);
  if (existsSync(evidenceFile)) {
    throw new RecoveryValidationError(
      "EVIDENCE_ALREADY_EXISTS",
      "Recovery evidence is append-only; choose a new run ID.",
    );
  }

  return Object.freeze({
    expectedEnvironment,
    dataClass,
    targetDatabase,
    runId,
    expectedMigrationVersion: Number.parseInt(expectedMigrationVersionText, 10),
    archive,
    evidenceDirectory,
    evidenceFile,
    admin,
    target,
    tombstoneReapplicator,
    tombstoneLedger,
    tombstoneLedgerSha256,
  });
}

function exactKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function parseTombstoneAttestation(
  text,
  { runId, targetDatabase, ledgerSha256 },
) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RecoveryValidationError(
      "TOMBSTONE_ATTESTATION_INVALID",
      "The tombstone reapplicator did not return valid attestation JSON.",
    );
  }
  if (
    !exactKeys(value, [
      "database",
      "ledgerSha256",
      "recordsAlreadyApplied",
      "recordsApplied",
      "recordsRead",
      "runId",
      "schemaVersion",
      "state",
    ]) ||
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    value.database !== targetDatabase ||
    value.ledgerSha256 !== ledgerSha256 ||
    value.state !== "COMPLETED" ||
    !Number.isSafeInteger(value.recordsRead) ||
    !Number.isSafeInteger(value.recordsApplied) ||
    !Number.isSafeInteger(value.recordsAlreadyApplied) ||
    value.recordsRead < 0 ||
    value.recordsApplied < 0 ||
    value.recordsAlreadyApplied < 0 ||
    value.recordsApplied + value.recordsAlreadyApplied !== value.recordsRead
  ) {
    throw new RecoveryValidationError(
      "TOMBSTONE_ATTESTATION_MISMATCH",
      "The tombstone reapplication attestation does not match this recovery run.",
    );
  }
  return Object.freeze(value);
}

function sameTombstoneAttestation(left, right) {
  return [
    "schemaVersion",
    "runId",
    "database",
    "ledgerSha256",
    "recordsRead",
    "recordsApplied",
    "recordsAlreadyApplied",
    "state",
  ].every((field) => left[field] === right[field]);
}

function parsePostgresUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RecoveryValidationError(
      "INVALID_DATABASE_URL",
      "Invalid PostgreSQL URL.",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new RecoveryValidationError(
      "INVALID_DATABASE_URL",
      "A PostgreSQL URL is required.",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database || database.includes("/")) {
    throw new RecoveryValidationError(
      "INVALID_DATABASE_URL",
      "PostgreSQL URL must include host, principal and one database name.",
    );
  }
  const parameters = [...url.searchParams.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const parameterNames = new Set();
  for (const [name] of parameters) {
    if (!URL_PARAMETER_ENV.has(name)) {
      throw new RecoveryValidationError(
        "UNSUPPORTED_DATABASE_PARAMETER",
        `Unsupported PostgreSQL URL parameter: ${name}.`,
      );
    }
    if (parameterNames.has(name)) {
      throw new RecoveryValidationError(
        "DUPLICATE_DATABASE_PARAMETER",
        `Duplicate PostgreSQL URL parameter: ${name}.`,
      );
    }
    parameterNames.add(name);
  }
  return Object.freeze({
    host: url.hostname,
    port: url.port || "5432",
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    parameters,
  });
}

function connectionIdentity(connection) {
  return JSON.stringify([
    connection.host,
    connection.port,
    connection.username,
    connection.password,
    connection.parameters,
  ]);
}

function postgresEnvironment(connection, database = connection.database) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith("PG")) {
      delete environment[name];
    }
  }
  Object.assign(environment, {
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.username,
    PGPASSWORD: connection.password,
    PGDATABASE: database,
  });
  for (const [name, value] of connection.parameters) {
    environment[URL_PARAMETER_ENV.get(name)] = value;
  }
  return environment;
}

function run(binary, args, environment) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new RecoveryValidationError(
      "COMMAND_FAILED",
      `${binary} failed without exposing command output or credentials.`,
    );
  }
  return result.stdout.trim();
}

function query(connection, database, sql, execute = run) {
  return execute(
    "psql",
    [
      "--no-align",
      "--tuples-only",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      sql,
    ],
    postgresEnvironment(connection, database),
  );
}

function assertRegularFile(file, code) {
  if (!existsSync(file) || !lstatSync(file).isFile()) {
    throw new RecoveryValidationError(
      code,
      "Required input file does not exist.",
    );
  }
}

function assertExecutableFile(file) {
  assertRegularFile(file, "TOMBSTONE_REAPPLICATOR_NOT_FOUND");
  if (process.platform !== "win32" && (lstatSync(file).mode & 0o111) === 0) {
    throw new RecoveryValidationError(
      "TOMBSTONE_REAPPLICATOR_NOT_EXECUTABLE",
      "Tombstone reapplicator must be executable.",
    );
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function writeEvidence(configuration, evidence) {
  mkdirSync(configuration.evidenceDirectory, { recursive: true, mode: 0o700 });
  if (existsSync(configuration.evidenceFile)) {
    throw new RecoveryValidationError(
      "EVIDENCE_ALREADY_EXISTS",
      "Recovery evidence is append-only; choose a new run ID.",
    );
  }
  writeFileSync(
    configuration.evidenceFile,
    `${JSON.stringify(evidence, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

export async function runRestoreVerification(
  environment = process.env,
  dependencies = {},
) {
  const configuration = parseConfiguration(environment);
  const execute = dependencies.run ?? run;
  const output =
    dependencies.output ?? ((message) => process.stdout.write(message));
  const startedAt = new Date().toISOString();
  let targetCreated = false;

  try {
    execute("pg_restore", ["--list", configuration.archive], process.env);

    const adminMarker = query(
      configuration.admin,
      configuration.admin.database,
      "SELECT COALESCE(current_setting('portal.environment', true), '');",
      execute,
    );
    if (adminMarker !== configuration.expectedEnvironment) {
      throw new RecoveryValidationError(
        "ENVIRONMENT_MARKER_MISMATCH",
        "Server-side environment marker does not match the requested isolated environment.",
      );
    }

    const targetExists = query(
      configuration.admin,
      configuration.admin.database,
      `SELECT COUNT(*) FROM pg_database WHERE datname = '${configuration.targetDatabase}';`,
      execute,
    );
    if (targetExists !== "0") {
      throw new RecoveryValidationError(
        "TARGET_ALREADY_EXISTS",
        "Restore target already exists; this tool never overwrites a database.",
      );
    }

    execute(
      "createdb",
      [
        "--maintenance-db",
        configuration.admin.database,
        configuration.targetDatabase,
      ],
      postgresEnvironment(configuration.admin),
    );
    targetCreated = true;

    const targetMarker = query(
      configuration.target,
      configuration.targetDatabase,
      "SELECT COALESCE(current_setting('portal.environment', true), '');",
      execute,
    );
    if (targetMarker !== configuration.expectedEnvironment) {
      throw new RecoveryValidationError(
        "TARGET_MARKER_MISMATCH",
        "New restore target did not inherit the server-side environment marker.",
      );
    }

    execute(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        "--dbname",
        configuration.targetDatabase,
        configuration.archive,
      ],
      postgresEnvironment(configuration.target, configuration.targetDatabase),
    );

    let tombstoneState = "not-required-for-non-production-data";
    if (configuration.dataClass === "production") {
      const actualLedgerSha256 = await sha256(configuration.tombstoneLedger);
      if (actualLedgerSha256 !== configuration.tombstoneLedgerSha256) {
        throw new RecoveryValidationError(
          "TOMBSTONE_LEDGER_DIGEST_MISMATCH",
          "The normalized tombstone ledger does not match its approved digest.",
        );
      }
      const attestationText = execute(configuration.tombstoneReapplicator, [], {
        ...postgresEnvironment(
          configuration.target,
          configuration.targetDatabase,
        ),
        PORTAL_RECOVERY_RUN_ID: configuration.runId,
        PORTAL_TOMBSTONE_LEDGER: configuration.tombstoneLedger,
        PORTAL_TOMBSTONE_LEDGER_SHA256: actualLedgerSha256,
      });
      const attestation = parseTombstoneAttestation(attestationText, {
        runId: configuration.runId,
        targetDatabase: configuration.targetDatabase,
        ledgerSha256: actualLedgerSha256,
      });
      const databaseAttestationText = query(
        configuration.target,
        configuration.targetDatabase,
        `SELECT json_build_object(
          'schemaVersion', 1,
          'runId', run_id,
          'database', current_database(),
          'ledgerSha256', ledger_sha256,
          'recordsRead', records_expected,
          'recordsApplied', records_applied,
          'recordsAlreadyApplied', records_already_applied,
          'state', state::text
        )::text
        FROM privacy_restore_reapplication_runs
        WHERE run_id = '${configuration.runId}'
          AND ledger_sha256 = '${actualLedgerSha256}'
          AND state = 'COMPLETED';`,
        execute,
      );
      const databaseAttestation = parseTombstoneAttestation(
        databaseAttestationText,
        {
          runId: configuration.runId,
          targetDatabase: configuration.targetDatabase,
          ledgerSha256: actualLedgerSha256,
        },
      );
      if (!sameTombstoneAttestation(databaseAttestation, attestation)) {
        throw new RecoveryValidationError(
          "TOMBSTONE_DATABASE_ATTESTATION_MISMATCH",
          "The hook and database tombstone attestations differ.",
        );
      }
      tombstoneState = Object.freeze({
        status: "reapplied-and-database-attested",
        ledgerSha256: actualLedgerSha256,
        recordsRead: attestation.recordsRead,
        recordsApplied: attestation.recordsApplied,
        recordsAlreadyApplied: attestation.recordsAlreadyApplied,
      });
    }

    const verificationText = query(
      configuration.target,
      configuration.targetDatabase,
      `SELECT json_build_object(
        'database', current_database(),
        'environment', COALESCE(current_setting('portal.environment', true), ''),
        'postgis', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis'),
        'migrationLedger', to_regclass('public.portal_schema_migrations') IS NOT NULL,
        'latestMigration', COALESCE((SELECT MAX(version) FROM portal_schema_migrations), -1),
        'usersTable', to_regclass('public.users') IS NOT NULL
      )::text;`,
      execute,
    );
    const checks = JSON.parse(verificationText);
    const checksPassed =
      checks.database === configuration.targetDatabase &&
      checks.environment === configuration.expectedEnvironment &&
      checks.postgis === true &&
      checks.migrationLedger === true &&
      checks.latestMigration === configuration.expectedMigrationVersion &&
      checks.usersTable === true;
    if (!checksPassed) {
      throw new RecoveryValidationError(
        "RESTORE_VERIFICATION_FAILED",
        "Restored schema, extension or migration version did not match expectations.",
      );
    }

    writeEvidence(configuration, {
      schemaVersion: 1,
      runId: configuration.runId,
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      environment: configuration.expectedEnvironment,
      dataClass: configuration.dataClass,
      targetDatabase: configuration.targetDatabase,
      archiveSha256: await sha256(configuration.archive),
      tombstoneState,
      checks,
      containsCredentialsOrPersonalData: false,
    });
    output(
      `Restore verification passed; evidence: ${configuration.evidenceFile}\n`,
    );
  } catch (error) {
    const code =
      error instanceof RecoveryValidationError
        ? error.code
        : "UNEXPECTED_FAILURE";
    if (!existsSync(configuration.evidenceFile)) {
      writeEvidence(configuration, {
        schemaVersion: 1,
        runId: configuration.runId,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        environment: configuration.expectedEnvironment,
        dataClass: configuration.dataClass,
        targetDatabase: configuration.targetDatabase,
        targetCreated,
        failureCode: code,
        containsCredentialsOrPersonalData: false,
      });
    }
    throw error;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runRestoreVerification().catch((error) => {
    const code =
      error instanceof RecoveryValidationError
        ? error.code
        : "UNEXPECTED_FAILURE";
    process.stderr.write(
      `Restore verification failed (${code}). Inspect the configured evidence directory if a run record was initialized.\n`,
    );
    process.exitCode = 1;
  });
}
