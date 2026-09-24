import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0098_job_dispute_cases.sql", import.meta.url),
  "utf8",
);
const repository = readFileSync(
  new URL("../src/job-dispute-repository.ts", import.meta.url),
  "utf8",
);

describe("R4-021 Job dispute schema", () => {
  it("models a separate exact-Job case with every locked alpha state and category", () => {
    expect(migration).toContain("CREATE TABLE dispute_cases");
    expect(migration).toContain("job_id uuid NOT NULL REFERENCES jobs(id)");
    for (const state of [
      "OPEN",
      "WAITING_FOR_PARTY",
      "UNDER_REVIEW",
      "RESOLVED",
      "CLOSED",
    ])
      expect(migration).toContain(`'${state}'`);
    for (const category of [
      "UNFINISHED_WORK",
      "QUALITY_DEFECT",
      "SCOPE",
      "PRICE_CHANGE_ORDER",
      "SCHEDULE",
      "MATERIAL",
      "DOCUMENTS",
      "CANCELLATION",
      "COMMUNICATION_BEHAVIOR",
      "OTHER",
    ])
      expect(migration).toContain(`'${category}'`);
    expect(migration).not.toMatch(/ALTER TABLE jobs\s+ADD COLUMN.*dispute/isu);
  });

  it("admits only active verified customer or primary-provider owners", () => {
    expect(migration).toContain("CREATE FUNCTION dispute_actor_role");
    expect(migration).toContain("actor.account_state = 'ACTIVE'");
    expect(migration).toContain("credential.email_verified_at IS NOT NULL");
    expect(migration).toContain("credential.phone_verified_at IS NOT NULL");
    expect(migration).toContain(
      "contractual Job party required to open dispute",
    );
    expect(migration).not.toContain("job_participant_actor_role");
  });

  it("preserves statements, addenda, state and evidence as immutable history", () => {
    expect(migration).toContain("CREATE TABLE dispute_case_state_events");
    expect(migration).toContain("CREATE TABLE dispute_case_statements");
    expect(migration).toContain("CREATE TABLE dispute_case_evidence");
    expect(migration).toContain("STATEMENT', 'ADDENDUM");
    expect(migration).toContain("NEW_UPLOAD', 'EXISTING_JOB_EVIDENCE");
    expect(migration.match(/BEFORE UPDATE OR DELETE/gu)).toHaveLength(4);
    expect(migration).toContain("Dispute case history is immutable");
  });

  it("requires READY private clean media with exact case or same-Job provenance", () => {
    expect(migration).toContain("asset.status <> 'READY'");
    expect(migration).toContain(
      "asset.malware_scan_verdict IS DISTINCT FROM 'CLEAN'",
    );
    expect(migration).toContain("asset.purpose <> 'DISPUTE_EVIDENCE'");
    expect(migration).toContain(
      "asset.provenance_entity_type <> 'DISPUTE_CASE'",
    );
    expect(migration).toContain("media.job_id = target_job_id");
    expect(migration).toContain("canonical.storage_area = 'private'");
  });

  it("opens at OPEN and emits only a privacy-minimal counterparty notification", () => {
    expect(migration).toContain("1, 'OPEN', NULL, 'OPEN'");
    expect(migration).toContain("'job.dispute.opened'");
    expect(migration).toContain("'recipient_user_id'");
    expect(migration).toContain("'dispute_id'");
    const payload = migration.slice(
      migration.indexOf("jsonb_build_object("),
      migration.indexOf(
        "'job.dispute.opened', NEW.id::text",
        migration.indexOf("jsonb_build_object("),
      ),
    );
    expect(payload).not.toContain("description");
    expect(payload).not.toContain("desired_resolution");
  });

  it("contains no automatic Job, agreement, payment, reputation or moderation mutation", () => {
    expect(migration).not.toMatch(/UPDATE\s+jobs/iu);
    expect(migration).not.toMatch(/UPDATE\s+job_agreement_snapshots/iu);
    expect(migration).not.toMatch(/UPDATE\s+moderation_/iu);
    expect(migration).not.toMatch(/UPDATE\s+craftsman_/iu);
    expect(migration).not.toMatch(/refund|escrow|guilty|not guilty/iu);
  });

  it("keeps the upload-readiness projection syntactically grouped before its alias", () => {
    expect(repository).toContain('END AS "canonicalReady"');
    expect(repository).toContain("WHEN asset.kind = 'IMAGE' THEN EXISTS");
    expect(repository).toContain("WHEN asset.kind = 'DOCUMENT' THEN");
  });
});
