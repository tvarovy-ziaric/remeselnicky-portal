import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../migrations/0048_quote_core.sql", import.meta.url)),
  "utf8",
);

describe("Quote core migration", () => {
  it("keeps one invitation/conversation lineage with immutable revisions", () => {
    expect(migration).toContain("invitation_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("conversation_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("CREATE TABLE quote_revision_identities");
    expect(migration).toContain("quote core history is append-only");
    expect(migration).toContain("request_content_revision integer NOT NULL");
    expect(migration).toContain("request_visible_version integer NOT NULL");
  });

  it("allows exactly one private draft beside one customer-visible submission", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX quote_one_provider_draft_idx",
    );
    expect(migration).toContain("WHERE state = 'DRAFT'");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX quote_one_customer_submitted_idx",
    );
    expect(migration).toContain("WHERE state = 'SUBMITTED'");
    expect(migration).toContain("NEW.prior_target_state := 'SUPERSEDED'");
  });

  it("fails submission closed until authoring migrations supply eligibility", () => {
    expect(migration).toContain("quote_revision_authoring_is_eligible");
    expect(migration).toContain("SELECT false");
    expect(migration).toContain("quote authoring is not ready for submission");
    expect(migration).not.toMatch(/jsonb|payload json/iu);
  });

  it("uses server-owned sequencing/timestamps and exact deferred effects", () => {
    expect(migration).toContain("NEW.quote_id := gen_random_uuid()");
    expect(migration).toContain("NEW.quote_revision := next_revision");
    expect(migration).toContain("NEW.changed_at := clock_timestamp()");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("quote_command_created_quote_effect_fk");
    expect(migration).toContain("quote_command_created_revision_effect_fk");
    expect(migration).toContain("quote_command_primary_state_effect_fk");
    expect(migration).toContain("quote_command_prior_state_effect_fk");
  });

  it("locks and reauthorizes exact active participants before every command", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("actor.account_state = 'ACTIVE'");
    expect(migration).toContain("conversation.invitation_state = 'ENGAGED'");
    expect(migration).toContain("craftsman.owner_user_id = actor.id");
    expect(migration).toContain("customer.owner_user_id = actor.id");
  });
});
