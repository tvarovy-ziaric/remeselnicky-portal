import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0025_portfolio_project_photos.sql", import.meta.url),
  ),
  "utf8",
);

describe("portfolio project photo migration", () => {
  it("locks the alpha phases, active/hidden lifecycle and max 15", () => {
    expect(migration).toMatch(/'BEFORE', 'PROGRESS', 'AFTER', 'OTHER'/u);
    expect(migration).toMatch(
      /portfolio_photo_state AS ENUM \('ACTIVE', 'HIDDEN'\)/u,
    );
    expect(migration).toMatch(/active_count > 15/u);
    expect(migration).toMatch(/'HIDE', 'RESTORE'/u);
    expect(migration).not.toMatch(/DELETE FROM portfolio_photo/u);
  });

  it("requires one globally authoritative ready canonical portfolio image", () => {
    expect(migration).toMatch(/media_asset_id uuid NOT NULL UNIQUE/u);
    expect(migration).toMatch(/asset.kind <> 'IMAGE'/u);
    expect(migration).toMatch(/asset.purpose <> 'PORTFOLIO_IMAGE'/u);
    expect(migration).toMatch(/asset.status <> 'READY'/u);
    expect(migration).toMatch(
      /asset.provenance_entity_type <> 'PORTFOLIO_PROJECT'/u,
    );
    expect(migration).toMatch(/object.role = 'CANONICAL'/u);
    expect(migration).toMatch(/FOR UPDATE;/u);
  });

  it("binds snapshot metadata and seals items in their parent transaction", () => {
    expect(migration).toMatch(
      /item.captured_at IS NOT DISTINCT FROM asset.captured_at/u,
    );
    expect(migration).toMatch(
      /item.canonical_width IS NOT DISTINCT FROM asset.canonical_width/u,
    );
    expect(migration).toMatch(
      /created_transaction_id bigint NOT NULL DEFAULT txid_current\(\)/u,
    );
    expect(migration).toMatch(/must be sealed with their parent revision/u);
  });

  it("uses the shared owner-project-photo-set lock order and exact effects", () => {
    const ownerLock = migration.indexOf("PERFORM lock_active_portfolio_owner");
    const projectLock = migration.indexOf(
      "SELECT * INTO project FROM portfolio_projects",
    );
    const setLock = migration.indexOf(
      "SELECT * INTO photo_set FROM portfolio_project_photo_sets",
    );
    expect(ownerLock).toBeGreaterThan(-1);
    expect(ownerLock).toBeLessThan(projectLock);
    expect(projectLock).toBeLessThan(setLock);
    expect(migration).toMatch(/requires exact set and revision effects/u);
    expect(migration).toMatch(/invalid portfolio photo reorder effect/u);
  });

  it("exposes only a private metadata projection", () => {
    expect(migration).toMatch(/CREATE VIEW current_portfolio_project_photos/u);
    expect(migration).not.toMatch(
      /storage_key|public_derivative|customer_consent/u,
    );
    expect(migration).toMatch(/portfolio photo history is append-only/u);
  });
});
