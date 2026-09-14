import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0035_customer_shortlist.sql", import.meta.url),
  "utf8",
);

describe("customer shortlist schema", () => {
  it("keeps one private current membership without a five-item cap", () => {
    expect(migration).toContain("CREATE TABLE customer_shortlist_entries");
    expect(migration).toContain(
      "PRIMARY KEY (customer_profile_id, craftsman_profile_id)",
    );
    expect(migration).toContain("WHERE state = 'ACTIVE'");
    expect(migration).not.toMatch(
      /\n\s+(card|query_text|rank_score|distance_meters|address|phone|email)\s/iu,
    );
    expect(migration).not.toMatch(
      /cardinality|array_length|count\s*\([^)]*\)\s*<=\s*5/iu,
    );
  });

  it("enforces active ownership and current public eligibility for ADD only", () => {
    expect(migration).toContain("owner_state <> 'ACTIVE'");
    expect(migration).toContain("NEW.command_kind = 'ADD'");
    expect(migration).toContain("current_searchable_craftsman_profiles");
    expect(migration).not.toMatch(
      /NEW\.command_kind = 'REMOVE'[\s\S]{0,200}current_searchable/iu,
    );
  });

  it("serializes target publication and reciprocal actors in stable order", () => {
    expect(migration).toMatch(/FROM craftsman_profiles[\s\S]*FOR UPDATE/iu);
    expect(migration).toMatch(
      /WHERE id IN \(NEW\.actor_user_id, target_owner_id\)[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/iu,
    );
  });

  it("requires exact immutable command/effect provenance and CAS revisions", () => {
    expect(migration).toContain(
      "customer_shortlist command has stale revision".replace(
        "customer_shortlist ",
        "customer shortlist ",
      ),
    );
    expect(migration).toContain("customer_shortlist_command_effect_required");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("customer_shortlist_commands_append_only");
    expect(migration).toContain("customer_shortlist_effects_append_only");
    expect(migration).toContain("customer_shortlist_entries_no_delete");
  });
});
