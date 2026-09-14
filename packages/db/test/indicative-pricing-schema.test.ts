import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  indicativePricingCommands,
  indicativePricingEntries,
  indicativePricingEntryRevisions,
} from "../src/schema/indicative-pricing.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0019_indicative_pricing.sql", import.meta.url),
  ),
  "utf8",
);

describe("indicative pricing schema", () => {
  it("exports current rows, command idempotency and immutable revisions", () => {
    expect(indicativePricingEntries.amountCents).toBeDefined();
    expect(indicativePricingCommands.payloadFingerprint).toBeDefined();
    expect(indicativePricingEntryRevisions.revision).toBeDefined();
  });

  it("uses exact positive EUR cents and all locked D08 modes", () => {
    expect(migration).toMatch(/amount_cents bigint NOT NULL/u);
    expect(migration).toMatch(/amount_cents BETWEEN 1 AND 9007199254740991/u);
    expect(migration).toMatch(/currency = 'EUR'/u);
    for (const mode of [
      "FROM",
      "APPROXIMATE",
      "HOURLY",
      "PER_SQUARE_METER",
      "PER_UNIT",
      "OTHER",
    ]) {
      expect(migration).toContain(`'${mode}'`);
    }
    expect(migration).not.toMatch(/real|double precision|money/u);
  });

  it("keeps profession optional but validates same-profile active ownership", () => {
    expect(migration).toMatch(/craftsman_profession_id uuid\s+REFERENCES/u);
    expect(migration).toMatch(
      /profession must be active and owned by the same profile/u,
    );
    expect(migration).not.toMatch(/craftsman_profession_id uuid NOT NULL/u);
  });

  it("blocks contact, URL, address and secret text before future publication", () => {
    expect(migration).toMatch(/indicative_pricing_public_text_safe/u);
    expect(migration).toMatch(/https\?:\/\//u);
    expect(migration).toMatch(/password/u);
    expect(migration).toMatch(/námestie/u);
    expect(migration).toMatch(/service_name_safe/u);
    expect(migration).toMatch(/note_safe/u);
  });

  it("requires command provenance, contiguous snapshots and archive-only history", () => {
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/u);
    expect(migration).toMatch(/contiguous matching revision provenance/u);
    expect(migration).toMatch(
      /command requires exactly one matching revision effect/u,
    );
    expect(migration).toMatch(/history cannot be hard-deleted/u);
    expect(migration).toMatch(/revision history is append-only/u);
    expect(migration).not.toMatch(/DELETE FROM indicative_pricing/u);
  });

  it("has deterministic indexes and no arbitrary item-count cap", () => {
    expect(migration).toMatch(
      /\(craftsman_profile_id, created_at, id\)[\s\S]*WHERE state = 'ACTIVE'/u,
    );
    expect(migration).not.toMatch(/max.*price|max.*entr|count\(.*pricing/u);
  });
});
