import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0028_portfolio_publication_consent_hooks.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("portfolio publication migration", () => {
  it("keeps private objects separate from revocable public derivatives", () => {
    expect(migration).toMatch(/ADD COLUMN public_url text/u);
    expect(migration).toMatch(
      /storage_area = 'private' AND public_url IS NULL/u,
    );
    expect(migration).toMatch(
      /storage_area = 'public-derivative'[\s\S]*public_url ~ '\^https:\/\//u,
    );
    expect(migration).toMatch(
      /media_asset_storage_objects_live_role_unique[\s\S]*WHERE revoked_at IS NULL/u,
    );
    expect(migration).toMatch(/immutable_except_revoke/u);
  });

  it("seals exact publication snapshots and requires at least one photo", () => {
    expect(migration).toMatch(/PUBLISH', 'HIDE/u);
    expect(migration).toMatch(/active_photo_count < 1/u);
    expect(migration).toMatch(/must be transaction-sealed/u);
    expect(migration).toMatch(/must include every current photo/u);
    expect(migration).toMatch(/command requires exact effect/u);
    expect(migration).toMatch(/history is append-only/u);
  });

  it("publishes only current self-declared projects behind the public profile gate", () => {
    expect(migration).toMatch(/CREATE VIEW current_public_portfolio_projects/u);
    expect(migration).toMatch(/profile_publication\.effectively_public/u);
    expect(migration).toMatch(/project\.provenance_kind = 'SELF_DECLARED'/u);
    expect(migration).toMatch(/project\.record_state = 'DRAFT'/u);
    expect(migration).toMatch(
      /project\.revision = revision\.project_revision/u,
    );
    expect(migration).toMatch(/object\.revoked_at IS NULL/u);
    expect(migration).not.toMatch(/customer_name|exact_address|captured_at/u);
  });

  it("keeps Job-linked consent fail-closed for later scope-bound integration", () => {
    expect(migration).toMatch(
      /future Job provenance remains fail-closed until exact customer-consent binding/u,
    );
    expect(migration).not.toMatch(/consent *= *true|blanket_consent/u);
  });
});
