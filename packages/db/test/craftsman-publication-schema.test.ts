import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  craftsmanProfilePublicationCommands,
  craftsmanProfilePublicationRevisions,
  PROFILE_PUBLICATION_COMMAND_KINDS,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0024_craftsman_profile_publication.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("craftsman profile publication schema", () => {
  it("stores three independent axes in immutable CAS history", () => {
    expect(PROFILE_PUBLICATION_COMMAND_KINDS).toEqual([
      "SUBMIT_REVIEW",
      "SET_OWNER_VISIBILITY",
      "ADMIN_APPROVE",
      "ADMIN_REJECT",
      "MODERATION_HIDE",
      "MODERATION_RESTRICT",
      "MODERATION_RESTORE",
      "IDENTITY_REVIEW_REQUIRED",
    ]);
    const columns = getTableConfig(
      craftsmanProfilePublicationRevisions,
    ).columns.map(({ name }) => name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "review_state",
        "owner_visibility",
        "moderation_state",
        "revision",
        "changed_at",
      ]),
    );
    expect(migration).toContain("publication command has stale revision");
    expect(migration).toContain("publication history is append-only");
  });

  it("uses the exact dynamic D08 minimum and no optional richness fields", () => {
    expect(migration).toContain(
      "craftsman_profile_missing_publication_requirements",
    );
    for (const requirement of [
      "VALID_IDENTITY",
      "ABOUT",
      "ACTIVE_PROFESSION_WITH_DECLARED_LEVEL",
      "BASE_MUNICIPALITY",
      "NORMAL_RADIUS",
    ]) {
      expect(migration).toContain(requirement);
    }
    const readinessFunction = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION craftsman_profile_missing"),
      migration.indexOf("CREATE TABLE craftsman_profile_publication_commands"),
    );
    expect(readinessFunction).not.toMatch(
      /photo|logo|skill|specialization|pricing|portfolio|credential/iu,
    );
    expect(migration).toContain("COALESCE((");
    expect(migration).toContain("AS effectively_public");
  });

  it("locks MFA session, active role and profile before admin transitions", () => {
    expect(migration).toContain("JOIN admin_role_grants role_grant");
    expect(migration).toContain(
      "FOR UPDATE OF privileged, session, actor, factor, role_grant",
    );
    expect(migration).toContain("interval '10 minutes'");
    expect(migration).toContain("admin.profiles.moderate");
  });

  it("requires an exact atomic audit effect and rejects spoofable metadata", () => {
    const columns = getTableConfig(
      craftsmanProfilePublicationCommands,
    ).columns.map(({ name }) => name);
    expect(columns).toContain("audit_event_id");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain(
      "admin/system publication command requires exact audit effect",
    );
    expect(migration).toContain(
      "craftsman_profile_publication_commands_input_shape",
    );
    expect(migration).toContain("profile-service:identity-change");
    expect(migration).not.toMatch(/!~ E'\\\+\?/u);
  });

  it("exposes only an authoritative boundary, not public profile data", () => {
    expect(migration).toContain(
      "CREATE VIEW current_craftsman_profile_publications",
    );
    expect(migration).not.toMatch(/CREATE (MATERIALIZED )?VIEW public_/iu);
    expect(migration).not.toMatch(/phone|email|exact_address/iu);
  });
});
