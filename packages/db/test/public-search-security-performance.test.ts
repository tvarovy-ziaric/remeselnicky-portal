import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("R2 public-search security and bounded-query structure", () => {
  it("keeps live eligibility and public-field safety in the authoritative candidate view", async () => {
    const migration = await source(
      "../migrations/0029_craftsman_search_read_model.sql",
    );
    expect(migration).toMatch(
      /WHERE publication\.effectively_public[\s\S]*publication\.review_state = 'APPROVED'[\s\S]*publication\.owner_visibility = 'PUBLIC'[\s\S]*publication\.moderation_state = 'ALLOWED'[\s\S]*owner\.account_state = 'ACTIVE'[\s\S]*cardinality\(publication\.missing_requirements\) = 0/u,
    );
    expect(migration).toContain("craftsman_capability_public_text_safe");
    expect(migration).toMatch(
      /CREATE INDEX craftsman_profiles_search_identity_document_gin[\s\S]*USING gin/u,
    );
    expect(migration).not.toMatch(
      /email|phone|exact_address|street|storage_key|content_sha256|customer_name/iu,
    );
  });

  it("uses one stable read-only snapshot, a hard cohort cap, and batched fact queries", async () => {
    const repository = await source("../src/public-search-card-source.ts");
    expect(repository).toContain("isolation level repeatable read read only");
    expect(repository).toMatch(
      /maximumCandidates > 100[\s\S]*LIMIT \$\{maximumCandidates \+ 1\}/u,
    );
    expect(repository).toMatch(
      /craftsman_service_area_match_facts[\s\S]*ANY\(\$\{candidateIds\}::uuid\[\]\)/u,
    );
    expect(repository).toMatch(
      /craftsman_availability_match_facts[\s\S]*ANY\(\$\{candidateIds\}::uuid\[\]\)/u,
    );
    expect(repository).toMatch(
      /FROM unnest\(\$\{profileIds\}::uuid\[\]\) selected\(profile_id\)[\s\S]*evaluate_craftsman_credential_qualification/u,
    );
    expect(repository).not.toMatch(
      /for\s*\([^)]*candidate[^)]*\)[\s\S]{0,160}await sql/iu,
    );
  });

  it("keeps precise distance and availability data inside server-side facts", async () => {
    const distance = await source(
      "../migrations/0030_craftsman_distance_facts.sql",
    );
    const serviceArea = await source(
      "../migrations/0031_craftsman_service_area_matching.sql",
    );
    const availability = await source(
      "../migrations/0033_craftsman_availability_matching.sql",
    );
    const location = await source(
      "../migrations/0018_craftsman_service_area.sql",
    );
    expect(distance).toContain("SECURITY INVOKER");
    expect(distance).toMatch(
      /RETURNS TABLE \(\s*craftsman_profile_id uuid,\s*ranking_distance_meters integer,\s*approximate_distance_km integer\s*\)/u,
    );
    expect(serviceArea).toContain("include_outside_declared_area");
    expect(serviceArea).toContain("current_searchable_craftsman_profiles");
    expect(availability).toContain("current_searchable_craftsman_profiles");
    expect(availability).toMatch(
      /RETURNS TABLE \(\s*craftsman_profile_id uuid,\s*match_kind craftsman_availability_match_kind,\s*indicatively_available boolean\s*\)/u,
    );
    expect(location).toMatch(
      /location_municipalities_centroid_gix[\s\S]*USING gist \(centroid\)/u,
    );
  });
});

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}
