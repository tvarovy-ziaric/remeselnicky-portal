import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0108_privacy_account_closure.sql", import.meta.url),
  ),
  "utf8",
);

describe("D27 account-closure migration", () => {
  it("projects the current request without exposing request evidence", () => {
    expect(migration).toContain("CREATE VIEW current_privacy_request_cases");
    for (const field of [
      "request.case_id",
      "request.subject_user_id",
      "request.request_type",
      "latest.state",
      "latest.deadline_at",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).not.toMatch(
      /request_body|identity_document|export_blob/u,
    );
  });

  it("requires recent MFA and blocks unresolved Job or dispute obligations", () => {
    expect(migration).toContain("privacy_admin_session_is_recent");
    expect(migration).toContain("privacy_account_has_open_obligations");
    expect(migration).toContain("current_job_states");
    expect(migration).toContain("current_job_participants");
    expect(migration).toContain("current_dispute_cases");
    expect(migration).toContain("account closure blocked by active obligation");
  });

  it("deactivates exposure and sessions before category review without deleting shared history", () => {
    expect(migration).toContain("SET account_state = 'DEACTIVATED'");
    expect(migration).toContain("UPDATE auth_sessions");
    expect(migration).toContain("ACCOUNT_DEACTIVATED_CATEGORY_REVIEW_PENDING");
    expect(migration).toContain("enum_range(NULL::privacy_retention_category)");
    expect(migration).not.toMatch(/DELETE FROM (users|jobs|privacy_)/u);
  });

  it("keeps every category blocked until its reviewed policy is ready", () => {
    expect(migration).toContain("CREATE TABLE privacy_data_disposition_events");
    expect(migration).toContain("'REVIEW_REQUIRED', 'DELETE', 'ANONYMIZE'");
    expect(migration).toContain("legal_review_state = 'APPROVED'");
    expect(migration).toContain("launch_state = 'READY'");
    expect(migration).toContain("approved ready category policy required");
  });

  it("allows only named admin state transitions and blocks premature completion", () => {
    expect(migration).toContain("CREATE TABLE privacy_request_admin_commands");
    expect(migration).toContain("apply_privacy_request_admin_command");
    expect(migration).toContain("invalid privacy request transition");
    expect(migration).toContain(
      "all privacy category dispositions must complete",
    );
    expect(migration).toContain("NEW.expected_state = 'RECEIVED'");
    expect(migration).not.toMatch(/generic_status|new_status/u);
  });

  it("makes operational history immutable and retry-auditable", () => {
    expect(migration).toContain("command_id uuid PRIMARY KEY");
    expect(migration).toContain("case_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("payload_fingerprint char(64)");
    expect(migration).toContain("privacy_request_admin_commands_immutable");
    expect(migration).toContain("privacy operational history is append-only");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
  });
});
