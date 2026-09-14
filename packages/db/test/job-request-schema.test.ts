import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0036_job_request_core.sql", import.meta.url),
  "utf8",
);

describe("job request core schema", () => {
  it("stores private identities and derives current state from immutable revisions", () => {
    expect(migration).toContain("CREATE TABLE job_requests");
    expect(migration).toContain("CREATE TABLE job_request_revisions");
    expect(migration).toContain("CREATE VIEW current_job_requests");
    expect(migration).toContain("job_requests_append_only");
    expect(migration).toContain("job_request_revisions_append_only");
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
  });

  it("allows only CREATE_DRAFT then ACTIVATE with server-owned timestamps", () => {
    expect(migration).toContain("('DRAFT', 'ACTIVE')");
    expect(migration).toContain("('CREATE_DRAFT', 'ACTIVATE')");
    expect(migration).toContain("current_revision.state <> 'DRAFT'");
    expect(migration).toContain("NEW.created_at := clock_timestamp()");
    expect(migration).toContain("NEW.changed_at := source.created_at");
    expect(migration).toContain("NEW.activated_at := CASE");
  });

  it("fails activation closed until R3-004 supplies authoritative content validation", () => {
    expect(migration).toContain(
      "CREATE FUNCTION job_request_missing_submission_requirements(uuid, integer)",
    );
    expect(migration).toContain("'PRIMARY_PROFESSION'");
    expect(migration).toContain("'DESCRIPTION'");
    expect(migration).toContain("'MUNICIPALITY'");
    expect(migration).toMatch(
      /cardinality\(job_request_missing_submission_requirements\([\s\S]*<> 0/iu,
    );
    expect(migration).not.toContain(
      "CREATE TABLE job_request_submission_readiness",
    );
    expect(migration).not.toMatch(/eligibility_token\s+(uuid|text|varchar)/iu);
  });

  it("enforces active ownership, exact command effects, and append-only history", () => {
    expect(migration).toContain("owner_state <> 'ACTIVE'");
    expect(migration).toContain("owner_id <> NEW.actor_user_id");
    expect(migration).toContain("job_request_command_effect_required");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("job_request_commands_append_only");
  });

  it("contains no R3-002/R3-004 content, media, invitation, or autosave model", () => {
    expect(migration).not.toMatch(
      /title|description_text|budget|exact_address|media_asset_id|job_invitation|autosave/iu,
    );
  });
});
