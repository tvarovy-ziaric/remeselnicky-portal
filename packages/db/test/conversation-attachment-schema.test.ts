import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0046_conversation_attachments.sql", import.meta.url),
  "utf8",
);

describe("conversation attachment schema", () => {
  it("binds chat media to exact immutable message provenance", () => {
    expect(migration).toContain(
      "NEW.provenance_entity_type IS DISTINCT FROM 'CONVERSATION_MESSAGE'",
    );
    expect(migration).toContain("message.author_user_id = actor.id");
    expect(migration).toContain("NEW.owner_user_id <> NEW.uploaded_by_user_id");
    expect(migration).toContain(
      "conversation attachment identity and provenance are immutable",
    );
    expect(migration).toContain(
      "conversation attachment provenance is append-only",
    );
  });

  it("rechecks ACTIVE writable membership and technical per-message bounds", () => {
    expect(migration).toContain("actor.account_state = 'ACTIVE'");
    expect(migration).toContain("current.access_state = 'WRITABLE'");
    expect(migration).toContain("current_total >= 10");
    expect(migration).toContain("current_images >= 5");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION validate_conversation_message_command()",
    );
    expect(migration).toMatch(
      /FROM users actor[\s\S]*FOR UPDATE;[\s\S]*FROM job_invitations invitation[\s\S]*FOR UPDATE;/u,
    );
  });

  it("offers only a private future-Job candidate seam without Job or storage authority", () => {
    expect(migration).toContain(
      "CREATE VIEW conversation_job_media_candidates",
    );
    const view = migration.slice(
      migration.indexOf("CREATE VIEW conversation_job_media_candidates"),
      migration.indexOf("CREATE INDEX media_assets_conversation_message"),
    );
    expect(view).toContain("asset.status = 'READY'");
    expect(view).toContain("coalesce(asset.captured_at, asset.created_at)");
    expect(view).not.toMatch(/job_id|storage_key|public_url|exact_address/iu);
  });
});
