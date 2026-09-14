import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  privacyConsentEvents,
  privacyConsentPurposes,
  privacyPolicyVersions,
  privacyRequestCases,
  privacyRequestEvents,
  privacyRetentionPolicyVersions,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0012_privacy_compliance_scaffolding.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("privacy compliance schema", () => {
  it("exports policy, optional consent, retention and request primitives", () => {
    expect(privacyPolicyVersions.policyVersionId).toBeDefined();
    expect(privacyConsentPurposes.isGenuinelyOptional).toBeDefined();
    expect(privacyConsentEvents.revision).toBeDefined();
    expect(privacyRetentionPolicyVersions.legalReviewState).toBeDefined();
    expect(privacyRequestCases.requestType).toBeDefined();
    expect(privacyRequestEvents.actorUserId).toBeDefined();
  });

  it("binds optional consent text to the exact optional purpose", () => {
    expect(migration).toMatch(
      /privacy_policy_versions_consent_purpose_consistent/u,
    );
    expect(migration).toMatch(
      /accepted_policy\.optional_consent_purpose <> NEW\.purpose/u,
    );
    expect(migration).toMatch(/is_genuinely_optional = true/u);
    expect(migration).not.toMatch(/ACCOUNT_CREATION|CONTRACT_PROCESSING/u);
  });

  it("seeds every retention category as explicitly unresolved and blocked", () => {
    expect(migration.match(/'LEGAL_REVIEW_REQUIRED'/gu)).toHaveLength(17);
    expect(migration.match(/'UNRESOLVED', 'BLOCKED'/gu)).toHaveLength(17);
    expect(migration).toMatch(/privacy_retention_policy_review_consistent/u);
    expect(migration).toContain("validate_privacy_retention_sequence");
    expect(migration).toContain(
      "retention policy must extend current category head contiguously",
    );
    expect(migration).not.toMatch(/DELETE FROM|DROP TABLE|TRUNCATE|CASCADE/iu);
  });

  it("uses server timestamps, restrictive ownership and append-only history", () => {
    expect(migration).toMatch(/set_privacy_history_server_timestamp/u);
    expect(
      migration.match(/ON DELETE RESTRICT/gu)?.length ?? 0,
    ).toBeGreaterThan(5);
    expect(migration.match(/prevent_privacy_history_mutation/gu)?.length).toBe(
      7,
    );
    expect(migration).toMatch(/privacy_request_cases_append_only/u);
    expect(migration).toMatch(/privacy_consent_events_append_only/u);
  });

  it("enforces contiguous consent and request histories in the database", () => {
    expect(migration).toMatch(
      /first consent event must be revision 1 GRANTED/u,
    );
    expect(migration).toMatch(/consent revisions must be contiguous/u);
    expect(migration).toMatch(
      /first privacy request event must be revision 1 RECEIVED/u,
    );
    expect(migration).toMatch(/invalid privacy request transition/u);
    expect(migration).toMatch(/pg_advisory_xact_lock/u);
    expect(migration).toMatch(/FOR UPDATE/u);
  });

  it("represents account closure without deleting or cascading the user", () => {
    expect(migration).toMatch(/'ACCOUNT_CLOSURE'/u);
    expect(migration).toMatch(
      /subject_user_id uuid NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/u,
    );
    expect(migration).toMatch(
      /Account closure is represented without deleting the User row/u,
    );
  });
});
