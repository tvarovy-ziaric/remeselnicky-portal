import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  CRAFTSMAN_PROFILE_TYPE_VALUES,
  craftsmanProfiles,
  type NewCraftsmanProfileRecord,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0015_craftsman_profile.sql", import.meta.url),
  ),
  "utf8",
);

describe("CraftsmanProfile private draft persistence schema", () => {
  it("stores one type-discriminated profile per owning User", () => {
    const config = getTableConfig(craftsmanProfiles);

    expect(CRAFTSMAN_PROFILE_TYPE_VALUES).toEqual(["INDIVIDUAL", "COMPANY"]);
    expect(config.columns.map(({ name }) => name)).toEqual([
      "id",
      "owner_user_id",
      "profile_type",
      "real_first_name",
      "real_last_name",
      "nickname",
      "official_company_name",
      "company_registration_number",
      "about",
      "identity_verified_at",
      "identity_verification_reference",
      "company_registration_verified_at",
      "company_registration_verification_reference",
      "revision",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.uniqueConstraints
        .find(({ name }) => name === "craftsman_profiles_owner_user_id_key")
        ?.columns.map(({ name }) => name),
    ).toEqual(["owner_user_id"]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "craftsman_profiles_fields_match_type",
        "craftsman_profiles_about_safe",
        "craftsman_profiles_individual_identity_paired",
        "craftsman_profiles_revision_positive",
        "craftsman_profiles_timestamps_ordered",
      ]),
    );
  });

  it("allows identity and publication-minimum details to remain incomplete", () => {
    const draft: NewCraftsmanProfileRecord = {
      ownerUserId: "00000000-0000-4000-8000-000000001501",
      profileType: "INDIVIDUAL",
    };

    expect(draft).toEqual({
      ownerUserId: "00000000-0000-4000-8000-000000001501",
      profileType: "INDIVIDUAL",
    });
  });

  it("has no public projection, contact detail, profession or location fields", () => {
    const columnNames = getTableConfig(craftsmanProfiles).columns.map(
      ({ name }) => name,
    );

    expect(columnNames).not.toEqual(
      expect.arrayContaining([
        "email",
        "phone",
        "is_public",
        "is_indexable",
        "profession_id",
        "municipality_id",
      ]),
    );
    expect(migration).not.toMatch(/CREATE VIEW|PUBLICATION|PUBLISH/iu);
  });

  it("enforces ACTIVE creation, server revisions and history preservation", () => {
    expect(migration).toContain("craftsman_profiles_active_owner_insert_guard");
    expect(migration).toMatch(
      /WHERE id = NEW\.owner_user_id[\s\S]*FOR UPDATE/u,
    );
    expect(migration.match(/owner must be ACTIVE/gu)).toHaveLength(2);
    expect(migration).toMatch(
      /guard_craftsman_profile_mutation[\s\S]*WHERE id = OLD\.owner_user_id[\s\S]*FOR UPDATE/u,
    );
    expect(migration).toContain("NEW.revision := OLD.revision + 1");
    expect(migration).toContain("NEW.updated_at := clock_timestamp()");
    expect(migration).toContain("history cannot be hard-deleted");
    expect(migration).toContain("ownership cannot be reassigned in place");
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
  });

  it("keeps verification server-authored and invalidates stale provenance", () => {
    expect(migration).toContain("NEW.identity_verified_at := NULL");
    expect(migration).toContain("NEW.company_registration_verified_at := NULL");
    expect(migration).toContain(
      "changed identity must clear prior verification provenance",
    );
    expect(migration).toContain(
      "changed registration must clear prior verification provenance",
    );
  });

  it("allows multiline About text while rejecting other control characters", () => {
    expect(migration).toContain(
      "about !~ E'[\\\\x01-\\\\x09\\\\x0B-\\\\x1F\\\\x7F]'",
    );
    expect(migration).not.toMatch(/about !~ '\[\[:cntrl:\]\]'/u);
  });
});
