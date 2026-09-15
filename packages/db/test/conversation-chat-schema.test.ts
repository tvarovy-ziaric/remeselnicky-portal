import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0045_conversation_chat.sql", import.meta.url),
  ),
  "utf8",
);

describe("conversation chat schema", () => {
  it("keeps messages, participant state and reports append-only", () => {
    expect(migration).toContain("conversation_timeline_entries_append_only");
    expect(migration).toContain(
      "conversation_participant_state_revisions_append_only",
    );
    expect(migration).toContain("conversation_reports_append_only");
    expect(migration).toContain(
      "message command requires exact timeline effect",
    );
    expect(migration).toContain(
      "participant state command requires exact effect",
    );
  });

  it("gates writes to an ACTIVE exact participant and current WRITABLE state", () => {
    expect(migration).toContain("conversation_participant_is_active");
    expect(migration).toContain("actor.account_state = 'ACTIVE'");
    expect(migration).toContain("current.access_state = 'WRITABLE'");
    expect(migration).toContain("customer.owner_user_id = actor.id");
    expect(migration).toContain("craftsman.owner_user_id = actor.id");
  });

  it("uses immutable engagement provenance for its first system event", () => {
    expect(migration).toContain("create_engagement_timeline_entry");
    expect(migration).toContain("revision.state = 'ENGAGED'");
    expect(migration).toContain(
      "UNIQUE (source_invitation_id, source_invitation_revision, system_event)",
    );
  });

  it("stores only a report category and optional exact message reference", () => {
    const reportTable = migration.slice(
      migration.indexOf("CREATE TABLE conversation_reports"),
      migration.indexOf("CREATE FUNCTION conversation_participant_is_active"),
    );
    expect(reportTable).toContain("reason conversation_report_reason");
    expect(reportTable).toContain("message_id uuid");
    expect(reportTable).not.toMatch(/details|body|email|phone|address/iu);
  });

  it("does not permit obvious pre-confirmation contact/address disclosure", () => {
    expect(migration).toContain(
      "message blocked by pre-confirmation contact policy",
    );
    expect(migration).toMatch(/NEW\.body ~\*/u);
  });
});
