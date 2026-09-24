import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0107_final_permission_matrix.sql", import.meta.url),
  ),
  "utf8",
);

describe("final D26 permission matrix migration", () => {
  it("composes every command scope with the global ACCOUNT restriction", () => {
    expect(migration).toContain("CREATE FUNCTION moderation_user_scope_allows");
    expect(migration).toContain(
      "restriction.enforcement_scope IN ('ACCOUNT', requested_scope)",
    );
    expect(migration).toContain("USING ERRCODE = '42501'");
    expect(migration).toContain("current_moderation_user_restrictions");
  });

  it.each([
    ["PUBLISHING", "craftsman_profession_commands"],
    ["PUBLISHING", "craftsman_profile_publication_commands"],
    ["PUBLISHING", "portfolio_project_commands"],
    ["PUBLISHING", "credential_claim_commands"],
    ["MESSAGING", "conversation_message_commands"],
    ["QUOTING", "quote_core_commands"],
    ["QUOTING", "quote_structured_authoring_commands"],
    ["QUOTING", "quote_external_pdf_authoring_commands"],
    ["QUOTING", "quote_lifecycle_commands"],
    ["QUOTING", "quote_revision_supporting_documents"],
    ["QUOTING", "jobs"],
    ["REVIEWS", "job_main_review_events"],
    ["REVIEWS", "job_context_reviews"],
    ["REVIEWS", "job_supervisor_evaluations"],
    ["REVIEWS", "job_main_review_responses"],
  ] as const)("maps %s restrictions to %s", (scope, table) => {
    expect(migration).toMatch(
      new RegExp(`BEFORE INSERT ON ${table}[\\s\\S]{0,180}'${scope}'`, "u"),
    );
  });

  it.each([
    "customer_shortlist_commands",
    "job_request_commands",
    "job_invitation_commands",
    "conversation_participant_state_commands",
    "job_location_clarification_commands",
    "job_lifecycle_commands",
    "job_participant_events",
    "job_work_groups",
    "job_progress_updates",
    "job_issues",
    "job_milestones",
    "change_orders",
    "job_completion_attempts",
    "job_completion_proposals",
    "job_participant_role_decisions",
    "dispute_cases",
    "dispute_case_party_commands",
    "moderation_reports",
  ])("puts ordinary %s mutations behind ACCOUNT", (table) => {
    expect(migration).toMatch(
      new RegExp(`BEFORE INSERT ON ${table}[\\s\\S]{0,180}'ACCOUNT'`, "u"),
    );
  });

  it("classifies uploads by purpose without blocking processing transitions", () => {
    for (const token of [
      "WHEN 'PROFILE_IMAGE' THEN 'PUBLISHING'",
      "WHEN 'CHAT_IMAGE' THEN 'MESSAGING'",
      "WHEN 'QUOTE_DOCUMENT' THEN 'QUOTING'",
      "ELSE 'ACCOUNT'",
      "BEFORE INSERT ON media_assets",
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toContain("BEFORE INSERT OR UPDATE ON media_assets");
  });

  it("keeps appeal, privacy and privileged correction planes explicit exemptions", () => {
    for (const table of [
      "moderation_appeals",
      "moderation_appeal_admin_commands",
      "privacy_request_cases",
      "privacy_request_events",
      "moderation_admin_commands",
      "job_admin_completion_commands",
      "job_admin_cancellation_commands",
    ]) {
      expect(migration).not.toContain(`BEFORE INSERT ON ${table}`);
    }
  });
});
