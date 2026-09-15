import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0041_job_invitations.sql", import.meta.url),
  "utf8",
);

describe("job invitation schema", () => {
  it("keeps one immutable invitation lineage and exact version provenance", () => {
    expect(migration).toContain("job_invitations_pair_once");
    expect(migration).toContain("request_content_revision");
    expect(migration).toContain("request_visible_version");
    expect(migration).toContain("job_invitation_command_effect_required");
    expect(migration).toContain("job_invitation_identity_initialized");
    expect(migration).toContain("job invitation history is append-only");
  });

  it("enforces eligibility, qualification, active-five, and verified actors", () => {
    expect(migration).toContain(
      "active_invitation_limit integer NOT NULL DEFAULT 5",
    );
    expect(migration).toContain("current_craftsman_profile_publications");
    expect(migration).toContain("current_credential_qualification_policies");
    expect(migration).toContain("current_searchable_craftsman_credentials");
    expect(migration).toContain("actor_email_verified IS NULL");
    expect(migration).toContain("actor_phone_verified IS NULL");
    expect(migration).toContain("current.state IN ('PENDING', 'ENGAGED')");
  });

  it("uses server time and closes active invitations with the request", () => {
    expect(migration).toContain("expiry_days integer NOT NULL DEFAULT 7");
    expect(migration).toContain("clock_timestamp()");
    expect(migration).toContain("job_request_closes_active_invitations");
    expect(migration).toContain("'REQUEST_CLOSED'");
    expect(migration).toContain(
      "current_revision.expires_at <= clock_timestamp()",
    );
  });

  it("keeps lightweight decline notes contact-safe", () => {
    expect(migration).toContain("decline_note varchar(500)");
    expect(migration).toContain("https?://");
    expect(migration).toContain("[^[:space:]@]+@[^[:space:]@]+");
  });
});
