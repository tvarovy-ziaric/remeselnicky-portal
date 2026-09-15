import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0051_quote_lifecycle.sql", import.meta.url),
  ),
  "utf8",
);

describe("Quote lifecycle migration", () => {
  it("keeps lifecycle commands and exact state effects append-only", () => {
    expect(migration).toContain("CREATE TABLE quote_lifecycle_commands");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("quote_lifecycle_command_effect_fk");
    expect(migration).toContain("Quote lifecycle history is append-only");
    expect(migration).toContain(
      "(command_id IS NULL) <> (lifecycle_command_id IS NULL)",
    );
  });

  it("derives expiry from the DB clock and never accepts a user actor", () => {
    expect(migration).toContain("NEW.actor_kind := 'SYSTEM'");
    expect(migration).toContain("NEW.actor_user_id := NULL");
    expect(migration).toContain(
      "NEW.actor_system_reference := 'quote-lifecycle:deadline-sweeper'",
    );
    expect(migration).toContain("deadline > clock_timestamp()");
    expect(migration).not.toMatch(/make_interval|default.*valid/iu);
  });

  it("serializes lifecycle changes in canonical lock order and requires writable provider context", () => {
    const actor = migration.indexOf("FROM users actor");
    const invitation = migration.indexOf(
      "WHERE invitation.id = source_quote.invitation_id FOR UPDATE",
    );
    const conversation = migration.indexOf(
      "WHERE conversation.id = source_quote.conversation_id FOR UPDATE",
    );
    const quote = migration.indexOf(
      "WHERE quote.id = source_quote.id FOR UPDATE",
    );
    const head = migration.indexOf(
      "WHERE head.quote_id = source_quote.id AND head.quote_revision = NEW.quote_revision",
    );
    expect(actor).toBeGreaterThan(0);
    expect(invitation).toBeGreaterThan(actor);
    expect(conversation).toBeGreaterThan(invitation);
    expect(quote).toBeGreaterThan(conversation);
    expect(head).toBeGreaterThan(quote);
    expect(migration).toContain("NEW.actor_user_id, 'CRAFTSMAN', true");
  });

  it("allows a new draft only from the exact current submitted or latest terminal source", () => {
    expect(migration).toContain("source_quote_revision integer");
    expect(migration).toContain("quote_core_revision_source_fk");
    expect(migration).toContain(
      "NEW.source_state_revision := current_terminal.state_revision",
    );
    expect(migration).toContain("current.state IN ('EXPIRED', 'WITHDRAWN')");
    expect(migration).toContain(
      "SELECT max(identity.revision) FROM quote_revision_identities identity",
    );
    expect(migration).toContain("current_draft.quote_id IS NOT NULL");
    expect(migration).toContain("request.state::text = 'ACTIVE'");
    expect(migration).toContain(
      "exact current quote request provenance required",
    );
  });

  it("exposes explicitly lifecycle-only, volatile deadline/readiness facts", () => {
    expect(migration).toContain("CREATE VIEW current_quote_acceptance_context");
    expect(migration).toContain("AS materially_stale");
    expect(migration).toContain("AS deadline_passed");
    expect(migration).toContain("AS lifecycle_acceptance_eligible");
    expect(migration).toContain("clock_timestamp()");
    expect(migration).toContain("is not complete D16 acceptance authority");
  });
});
