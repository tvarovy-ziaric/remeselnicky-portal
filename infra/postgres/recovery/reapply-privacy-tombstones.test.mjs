import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runReapplication } from "./reapply-privacy-tombstones.mjs";

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "privacy-reapply-test-"));
  const tombstoneId = randomUUID();
  const lines = [
    JSON.stringify({
      ledgerCode: "synthetic.ledger",
      recordCount: 1,
      recordType: "PORTAL_PRIVACY_RECOVERY_LEDGER",
      schemaVersion: 1,
    }),
    JSON.stringify({
      category: "NOTIFICATION_DELIVERY",
      disposition: "DELETE",
      ledgerReceiptDigest: "a".repeat(64),
      policyVersionId: randomUUID(),
      recordType: "TOMBSTONE",
      sourceCreatedAt: "2026-09-25T10:00:00.000Z",
      sourceDispositionEventId: tombstoneId,
      subjectUserId: randomUUID(),
      tombstoneId,
    }),
  ];
  const content = `${lines.join("\n")}\n`;
  const ledger = join(directory, "ledger.jsonl");
  writeFileSync(ledger, content);
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    environment: {
      PORTAL_RECOVERY_RUN_ID: "restore-test-01",
      PORTAL_TOMBSTONE_LEDGER: ledger,
      PORTAL_TOMBSTONE_LEDGER_SHA256: digest,
      ...overrides,
    },
    digest,
    tombstoneId,
  };
}

test("builds one atomic database replay and returns only bounded attestation", () => {
  const input = fixture();
  let transaction;
  const result = runReapplication(input.environment, {
    runPsql(value) {
      transaction = value;
      return {
        database: "portal_restore_verify_test",
        ledgerSha256: input.digest,
        recordsAlreadyApplied: 0,
        recordsApplied: 1,
        recordsRead: 1,
        runId: "restore-test-01",
        schemaVersion: 1,
        state: "COMPLETED",
      };
    },
  });
  assert.equal(result.state, "COMPLETED");
  assert.match(transaction, /^BEGIN;/u);
  assert.match(transaction, /begin_privacy_restore_reapplication/u);
  assert.match(transaction, /apply_privacy_restore_tombstone/u);
  assert.match(transaction, /complete_privacy_restore_reapplication/u);
  assert.match(transaction, /COMMIT;\n$/u);
  assert.equal(transaction.includes(input.tombstoneId), true);
});

test("rejects a changed ledger before any database command", () => {
  const input = fixture({ PORTAL_TOMBSTONE_LEDGER_SHA256: "b".repeat(64) });
  let called = false;
  assert.throws(
    () =>
      runReapplication(input.environment, {
        runPsql() {
          called = true;
        },
      }),
    /digest mismatch/u,
  );
  assert.equal(called, false);
});

test("rejects malformed or duplicate normalized tombstones", () => {
  const duplicate = fixture();
  const content = readFileSync(
    duplicate.environment.PORTAL_TOMBSTONE_LEDGER,
    "utf8",
  );
  const lines = content.trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  header.recordCount = 2;
  const duplicated = `${JSON.stringify(header)}\n${lines[1]}\n${lines[1]}\n`;
  writeFileSync(duplicate.environment.PORTAL_TOMBSTONE_LEDGER, duplicated);
  duplicate.environment.PORTAL_TOMBSTONE_LEDGER_SHA256 = createHash("sha256")
    .update(duplicated)
    .digest("hex");
  assert.throws(
    () => runReapplication(duplicate.environment, { runPsql() {} }),
    /Invalid normalized tombstone record/u,
  );
});

test("rejects a hook/database attestation that does not cover every record", () => {
  const input = fixture();
  assert.throws(
    () =>
      runReapplication(input.environment, {
        runPsql() {
          return {
            database: "portal_restore_verify_test",
            ledgerSha256: input.digest,
            recordsAlreadyApplied: 0,
            recordsApplied: 0,
            recordsRead: 0,
            runId: "restore-test-01",
            schemaVersion: 1,
            state: "COMPLETED",
          };
        },
      }),
    /attestation mismatch/u,
  );
});
