import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CRAFTSMAN_SEARCH_READ_MODEL_VIEWS,
  SEARCHABLE_CRAFTSMAN_PROFILE_COLUMNS,
} from "../src/schema/craftsman-search-read-model.js";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0029_craftsman_search_read_model.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("craftsman search read model schema", () => {
  it("defines live security-invoker views and no mutable search authority", () => {
    for (const view of Object.values(CRAFTSMAN_SEARCH_READ_MODEL_VIEWS)) {
      expect(migration).toContain(`CREATE VIEW ${view}`);
      expect(
        migration.slice(migration.indexOf(`CREATE VIEW ${view}`)),
      ).toContain("WITH (security_invoker = true)");
    }
    expect(migration).not.toMatch(
      /CREATE MATERIALIZED VIEW|REFRESH MATERIALIZED/iu,
    );
    expect(migration).not.toMatch(/CREATE TABLE .*search/iu);
  });

  it("fails closed on every publication and ACTIVE-owner axis", () => {
    const base = baseViewSql();
    expect(base).toContain("publication.effectively_public");
    expect(base).toContain("publication.review_state = 'APPROVED'");
    expect(base).toContain("publication.owner_visibility = 'PUBLIC'");
    expect(base).toContain("publication.moderation_state = 'ALLOWED'");
    expect(base).toContain("owner.account_state = 'ACTIVE'");
    expect(base).toContain("cardinality(publication.missing_requirements) = 0");
    expect(base).toContain("municipality.is_active");
    expect(base).toContain("district.is_active");
    expect(base).toContain("region.is_active");
  });

  it("keeps one base row per profile and exposes only the reviewed columns", () => {
    expect(SEARCHABLE_CRAFTSMAN_PROFILE_COLUMNS).toEqual([
      "craftsman_profile_id",
      "profile_type",
      "primary_name",
      "secondary_name",
      "identity_search_document",
      "base_municipality_code",
      "base_municipality_name",
      "normal_radius_meters",
      "maximum_radius_meters",
      "extra_municipality_codes",
      "identity_verified",
      "company_registration_verified",
      "profile_revision",
      "publication_revision",
      "service_area_revision",
    ]);
    const selectList = baseViewSql().slice(0, baseViewSql().indexOf("FROM "));
    expect(selectList).not.toMatch(
      /owner_user_id|email|phone|address|centroid|latitude|longitude|storage|customer|registration_number|verification_reference/iu,
    );
    expect(baseViewSql()).not.toMatch(/JOIN\s+current_craftsman_professions/iu);
  });

  it("indexes all public identity variants with identical immutable normalization", () => {
    expect(migration).toContain(
      "craftsman_profiles_search_identity_document_gin",
    );
    expect(migration).toContain("craftsman_search_normalize_text");
    expect(migration).toContain("IMMUTABLE");
    expect(migration).toContain("COALESCE(nickname, '')");
    expect(migration).toContain("COALESCE(real_first_name, '')");
    expect(migration).toContain("COALESCE(real_last_name, '')");
    expect(migration).toContain("COALESCE(official_company_name, '')");
    expect(migration).not.toMatch(/unaccent/iu);
  });

  it("keeps declared/evidence facts separate and private sources out", () => {
    expect(migration).toContain("profession.evidence_supported_level");
    expect(migration).toContain("AS evidence_supported");
    expect(migration).toContain("claim.state = 'APPROVED'");
    expect(migration).toContain("claim.expires_on >= CURRENT_DATE");
    expect(migration).toContain("has_declared_availability");
    expect(migration).toContain("representative_media_asset_id");
    expect(migration).not.toMatch(
      /credential_claim_evidence|storage_key|public_url|content_sha256|starts_at AS|ends_at AS|photo_count|completeness|founder|sponsor|paid_boost|rank_score/iu,
    );
  });
});

function baseViewSql(): string {
  return migration.slice(
    migration.indexOf("CREATE VIEW current_searchable_craftsman_profiles"),
    migration.indexOf("CREATE VIEW current_searchable_craftsman_professions"),
  );
}
