import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0114_alpha_analytics_read_models.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("0114 D28 alpha analytics read models", () => {
  it("derives entity-aware request and dimension-safe supply facts", () => {
    expect(migration).toContain("CREATE VIEW r4_alpha_request_journey_facts");
    expect(migration).toContain("min(revision.activated_at)");
    expect(migration).toContain("count(DISTINCT quote.id)");
    expect(migration).toContain("completed_job_evidence_provenance");
    expect(migration).toContain("CREATE VIEW r4_alpha_supply_facts");
    expect(migration).toContain("section.content_revision = 1");
    expect(migration).toContain("qualification.profession_code");
  });

  it("lets TEST dominate INTERNAL and excludes arbitrary private content", () => {
    const testBranch = migration.indexOf(
      ") THEN 'TEST'::analytics_traffic_class",
    );
    const internalBranch = migration.indexOf(
      ") THEN 'INTERNAL'::analytics_traffic_class",
    );
    expect(testBranch).toBeGreaterThan(0);
    expect(internalBranch).toBeGreaterThan(testBranch);
    expect(migration).not.toMatch(
      /SELECT[^;]*(?:exactAddress|comment|description|details|note|reason|ratings|statement)/iu,
    );
  });

  it("captures only bounded search facts and protects immutable history", () => {
    expect(migration).toContain("CREATE TABLE r4_analytics_search_facts");
    expect(migration).toContain("candidate_count BETWEEN 0 AND 100");
    expect(migration).toContain(
      "r3_analytics_traffic_class(NEW.actor_user_id)",
    );
    expect(migration).toContain("analytics facts are append-only");
    expect(migration).not.toMatch(
      /(?:raw_query|query_text|latitude|longitude|email|phone|filename)/iu,
    );
  });
});
