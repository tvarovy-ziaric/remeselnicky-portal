import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0047_conversation_preconfirm_policy.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("conversation pre-confirmation policy schema", () => {
  it("backfills old accepted messages without claiming the current detector", () => {
    expect(migration).toContain(
      "policy_stage text NOT NULL DEFAULT 'LEGACY_PRE_CONFIRM'",
    );
    expect(migration).toContain("policy_version integer NOT NULL DEFAULT 0");
    expect(migration).toContain("ALTER COLUMN policy_stage DROP DEFAULT");
    expect(migration).not.toContain("UPDATE conversation_message_commands");
  });

  it("keeps stage resolution server-owned and fail closed", () => {
    expect(migration).toContain("conversation_message_policy_stage");
    expect(migration).toContain("ELSE NULL::text");
    expect(migration).toContain("NEW.policy_stage := resolved_policy_stage");
    expect(migration).toContain("NEW.policy_version := 1");
    expect(migration).toContain("resolved_policy_stage IS NULL");
    expect(migration).toContain("policy stage unavailable");
    expect(migration).not.toMatch(/job_id|confirmed_job_id/iu);
  });

  it("replaces the authoritative raw-SQL guard with the mirrored detector", () => {
    expect(migration).toContain(
      "CREATE FUNCTION conversation_message_violates_preconfirm_policy",
    );
    expect(migration).toContain("normalize(candidate, NFKC)");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION validate_conversation_message_command",
    );
    expect(migration).toContain("actor.account_state = 'ACTIVE'");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain(
      "message blocked by pre-confirmation contact policy",
    );
  });

  it("allows general links while limiting host rules to exact contact hosts", () => {
    expect(migration).toContain("instagram\\.com/");
    expect(migration).toContain("facebook\\.com/");
    expect(migration).toContain("wa\\.me");
    expect(migration).not.toContain("example.org");
  });
});
