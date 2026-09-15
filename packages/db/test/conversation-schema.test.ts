import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0044_conversation_entity.sql", import.meta.url),
  ),
  "utf8",
);

describe("conversation migration", () => {
  it("creates one immutable conversation only after historical engagement", () => {
    expect(migration).toContain("invitation_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("revision.state = 'ENGAGED'");
    expect(migration).toContain("NEW.id := gen_random_uuid()");
    expect(migration).toContain("conversation identity is append-only");
  });

  it("derives write access exclusively from the current invitation state", () => {
    expect(migration).toContain("CREATE VIEW current_conversations");
    expect(migration).toContain(
      "WHEN current.state = 'ENGAGED' THEN 'WRITABLE'",
    );
    expect(migration).toContain("ELSE 'READ_ONLY'");
    expect(migration).toContain("AFTER INSERT ON job_invitation_revisions");
    expect(migration).toContain("ON CONFLICT (invitation_id) DO NOTHING");
  });
});
