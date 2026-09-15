import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0049_quote_platform_structured.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("PLATFORM_STRUCTURED Quote migration", () => {
  it("binds append-only typed content to an exact Quote revision", () => {
    expect(migration).toContain(
      "CREATE TABLE quote_structured_content_revisions",
    );
    expect(migration).toContain("REFERENCES quote_revision_identities");
    expect(migration).toContain(
      "structured Quote authoring history is append-only",
    );
    expect(migration).not.toMatch(/jsonb|payload json/iu);
  });

  it("stores comparable price, scope, timing and commercial fields", () => {
    for (const field of [
      "price_mode",
      "total_amount_cents",
      "range_minimum_cents",
      "range_maximum_cents",
      "vat_status",
      "labor_amount_cents",
      "material_amount_cents",
      "transport_amount_cents",
      "other_amount_cents",
      "included_scope",
      "excluded_scope",
      "estimated_start_on",
      "estimated_duration_days",
      "valid_until",
      "warranty_information",
      "material_responsibility",
      "deposit_percentage_basis_points",
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).not.toMatch(/sum\s*\(/iu);
  });

  it("uses bounded integer cents/basis points and strict relational shapes", () => {
    expect(migration).toContain("bigint");
    expect(migration).toContain("BETWEEN 1 AND 1000000000000");
    expect(migration).toContain("BETWEEN 1 AND 10000");
    expect(migration).toContain("currency = 'EUR'");
    expect(migration).toContain("estimated_duration_days BETWEEN 1 AND 3650");
  });

  it("reuses the authoritative v1 pre-confirm detector for every text field", () => {
    expect(migration).toContain(
      "NOT conversation_message_violates_preconfirm_policy(candidate)",
    );
    expect(migration).not.toContain(
      "CREATE FUNCTION conversation_message_violates_preconfirm_policy",
    );
    expect(migration).toContain("quote_structured_scope_items_guard");
    expect(migration).toContain("candidate !~ '^[[:space:]]'");
    expect(migration).toContain("right(candidate, 1) !~ '[[:space:]]'");
    expect(migration).toContain("position(chr(13) in candidate) = 0");
    expect(migration).toContain("chr(160), chr(5760)");
    expect(migration).toContain("chr(65279)");
    expect(migration).not.toContain("candidate = btrim(candidate)");
    expect(migration).toContain("array_ndims(included_scope) = 1");
    expect(migration).toContain("array_lower(excluded_scope, 1) = 1");
  });

  it("serializes saves with Quote core commands and requires exact effects", () => {
    const invitationLock = migration.indexOf(
      "WHERE invitation.id = source_quote.invitation_id FOR UPDATE",
    );
    const conversationLock = migration.indexOf(
      "WHERE conversation.id = source_quote.conversation_id FOR UPDATE",
    );
    const quoteLock = migration.indexOf(
      "WHERE quote.id = NEW.quote_id FOR UPDATE",
    );
    const currentContentRead = migration.indexOf(
      "SELECT content.content_revision INTO current_content_revision",
    );
    expect(invitationLock).toBeGreaterThan(0);
    expect(conversationLock).toBeGreaterThan(invitationLock);
    expect(quoteLock).toBeGreaterThan(conversationLock);
    expect(currentContentRead).toBeGreaterThan(quoteLock);
    expect(migration).toContain(
      "AND head.quote_revision = NEW.quote_revision\n  FOR UPDATE",
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("quote_structured_command_effect_fk");
  });

  it("opens eligibility only for valid current structured content", () => {
    expect(migration).toContain("target_mode = 'PLATFORM_STRUCTURED'");
    expect(migration).toContain("LANGUAGE sql VOLATILE");
    expect(migration).toContain("content.valid_until > clock_timestamp()");
    expect(migration).toContain("ELSE false");
    expect(migration).not.toContain("target_mode = 'EXTERNAL_PDF' THEN");
  });
});
