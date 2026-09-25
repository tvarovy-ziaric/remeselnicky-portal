#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RUN_ID = /^[a-z0-9][a-z0-9_-]{5,63}$/;
const LEDGER_CODE = /^[a-z][a-z0-9.-]{1,63}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CATEGORY = new Set([
  "ACCOUNT_CORE",
  "ABANDONED_DRAFT",
  "PRE_JOB_CONVERSATION",
  "COMMERCIAL_JOB_RECORD",
  "PRIVATE_JOB_MEDIA",
  "PUBLIC_PORTFOLIO_MEDIA",
  "CREDENTIAL_EVIDENCE",
  "REJECTED_CREDENTIAL",
  "MALWARE_QUARANTINE",
  "DISPUTE_EVIDENCE",
  "MODERATION_SECURITY",
  "RISK_FLAG",
  "APPLICATION_LOG",
  "NOTIFICATION_DELIVERY",
  "AUDIT_EVENT",
  "PRIVACY_REQUEST_CASE",
  "BACKUP",
]);
const DISPOSITION = new Set(["DELETE", "ANONYMIZE"]);
const MAX_LEDGER_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000;

class ReapplicationError extends Error {}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new ReapplicationError(`${name} is required.`);
  return value;
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

function parseLedger(file, expectedSha256) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_LEDGER_BYTES)
    throw new ReapplicationError("Invalid normalized tombstone ledger file.");
  const content = readFileSync(file, "utf8");
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256)
    throw new ReapplicationError("Tombstone ledger digest mismatch.");
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1 || lines.some((line) => line.trim() !== line || !line))
    throw new ReapplicationError("Invalid normalized tombstone ledger lines.");
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new ReapplicationError("Invalid normalized tombstone ledger header.");
  }
  if (
    !exactKeys(header, [
      "ledgerCode",
      "recordCount",
      "recordType",
      "schemaVersion",
    ]) ||
    header.recordType !== "PORTAL_PRIVACY_RECOVERY_LEDGER" ||
    header.schemaVersion !== 1 ||
    !LEDGER_CODE.test(header.ledgerCode) ||
    !Number.isSafeInteger(header.recordCount) ||
    header.recordCount < 0 ||
    header.recordCount > MAX_RECORDS ||
    lines.length !== header.recordCount + 1
  )
    throw new ReapplicationError("Invalid normalized tombstone ledger header.");

  const tombstones = [];
  const identities = new Set();
  for (const line of lines.slice(1)) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new ReapplicationError("Invalid normalized tombstone record.");
    }
    if (
      !exactKeys(item, [
        "category",
        "disposition",
        "ledgerReceiptDigest",
        "policyVersionId",
        "recordType",
        "sourceCreatedAt",
        "sourceDispositionEventId",
        "subjectUserId",
        "tombstoneId",
      ]) ||
      item.recordType !== "TOMBSTONE" ||
      !UUID.test(item.tombstoneId) ||
      item.sourceDispositionEventId !== item.tombstoneId ||
      !UUID.test(item.subjectUserId) ||
      !CATEGORY.has(item.category) ||
      !DISPOSITION.has(item.disposition) ||
      !UUID.test(item.policyVersionId) ||
      !SHA256.test(item.ledgerReceiptDigest) ||
      typeof item.sourceCreatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
        item.sourceCreatedAt,
      ) ||
      !Number.isFinite(Date.parse(item.sourceCreatedAt)) ||
      identities.has(item.tombstoneId)
    )
      throw new ReapplicationError("Invalid normalized tombstone record.");
    identities.add(item.tombstoneId);
    tombstones.push(Object.freeze(item));
  }
  return Object.freeze({
    ledgerCode: header.ledgerCode,
    ledgerSha256: actualSha256,
    tombstones: Object.freeze(tombstones),
  });
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildTransaction(runId, ledger) {
  const statements = [
    "BEGIN;",
    `SELECT run_id FROM begin_privacy_restore_reapplication(${literal(runId)}, ${literal(ledger.ledgerCode)}, ${literal(ledger.ledgerSha256)}, ${ledger.tombstones.length});`,
  ];
  for (const item of ledger.tombstones) {
    statements.push(
      `SELECT outcome::text FROM apply_privacy_restore_tombstone(${literal(runId)}, ${literal(item.tombstoneId)}::uuid, ${literal(item.sourceDispositionEventId)}::uuid, ${literal(item.subjectUserId)}::uuid, ${literal(item.category)}::privacy_retention_category, ${literal(item.disposition)}::privacy_data_disposition, ${literal(item.policyVersionId)}::uuid, ${literal(item.ledgerReceiptDigest)}::char(64), ${literal(item.sourceCreatedAt)}::timestamptz);`,
    );
  }
  statements.push(
    `SELECT json_build_object('schemaVersion', 1, 'runId', run_id, 'database', current_database(), 'ledgerSha256', ledger_sha256, 'recordsRead', records_expected, 'recordsApplied', records_applied, 'recordsAlreadyApplied', records_already_applied, 'state', state::text)::text FROM complete_privacy_restore_reapplication(${literal(runId)});`,
    "COMMIT;",
  );
  return `${statements.join("\n")}\n`;
}

function runPsql(transaction, environment) {
  const result = spawnSync(
    "psql",
    ["--no-align", "--tuples-only", "--set", "ON_ERROR_STOP=1"],
    {
      encoding: "utf8",
      env: environment,
      input: transaction,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new ReapplicationError("Privacy tombstone transaction failed.");
  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = [...lines].reverse().find((line) => line.startsWith("{"));
  if (candidate === undefined)
    throw new ReapplicationError("Privacy tombstone attestation missing.");
  try {
    return JSON.parse(candidate);
  } catch {
    throw new ReapplicationError("Privacy tombstone attestation invalid.");
  }
}

export function runReapplication(environment = process.env, dependencies = {}) {
  const runId = required(environment, "PORTAL_RECOVERY_RUN_ID");
  const ledgerFile = required(environment, "PORTAL_TOMBSTONE_LEDGER");
  const expectedSha256 = required(
    environment,
    "PORTAL_TOMBSTONE_LEDGER_SHA256",
  );
  if (!RUN_ID.test(runId) || !SHA256.test(expectedSha256))
    throw new ReapplicationError("Invalid recovery reapplication identity.");
  const ledger = parseLedger(ledgerFile, expectedSha256);
  const attestation = (dependencies.runPsql ?? runPsql)(
    buildTransaction(runId, ledger),
    environment,
  );
  if (
    !exactKeys(attestation, [
      "database",
      "ledgerSha256",
      "recordsAlreadyApplied",
      "recordsApplied",
      "recordsRead",
      "runId",
      "schemaVersion",
      "state",
    ]) ||
    attestation.schemaVersion !== 1 ||
    attestation.runId !== runId ||
    attestation.ledgerSha256 !== expectedSha256 ||
    attestation.state !== "COMPLETED" ||
    typeof attestation.database !== "string" ||
    !Number.isSafeInteger(attestation.recordsRead) ||
    !Number.isSafeInteger(attestation.recordsApplied) ||
    !Number.isSafeInteger(attestation.recordsAlreadyApplied) ||
    attestation.recordsRead !== ledger.tombstones.length ||
    attestation.recordsApplied + attestation.recordsAlreadyApplied !==
      attestation.recordsRead
  )
    throw new ReapplicationError("Privacy tombstone attestation mismatch.");
  return Object.freeze(attestation);
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const attestation = runReapplication();
    process.stdout.write(`${JSON.stringify(attestation)}\n`);
  } catch {
    process.stderr.write(
      "Privacy tombstone reapplication failed without exposing ledger content.\n",
    );
    process.exitCode = 1;
  }
}
