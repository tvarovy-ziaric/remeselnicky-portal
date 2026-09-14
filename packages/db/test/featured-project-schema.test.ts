import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0027_featured_projects.sql", import.meta.url),
  ),
  "utf8",
);

describe("featured project migration", () => {
  it("enforces a unique ordered hard maximum of three in every layer", () => {
    expect(migration).toMatch(
      /portfolio_uuid_array_valid\(project_ids, 0, 3\)/u,
    );
    expect(migration).toMatch(
      /portfolio_uuid_array_valid\(resulting_project_ids, 0, 3\)/u,
    );
    expect(migration).toMatch(/PIN', 'UNPIN', 'REORDER/u);
  });

  it("requires active ownership and current draft projects", () => {
    expect(migration).toMatch(/lock_active_portfolio_owner/u);
    expect(migration).toMatch(
      /project.craftsman_profile_id = NEW.craftsman_profile_id/u,
    );
    expect(migration).toMatch(/project.author_user_id = NEW.actor_user_id/u);
    expect(migration).toMatch(/project.record_state = 'DRAFT'/u);
    expect(migration).toMatch(
      /owned current draft featured projects required/u,
    );
  });

  it("preserves exact full snapshots and append-only history", () => {
    expect(migration).toMatch(/revision requires exact command snapshot/u);
    expect(migration).toMatch(
      /command requires exact set and revision effects/u,
    );
    expect(migration).toMatch(/featured project history is append-only/u);
    expect(migration).not.toMatch(/DELETE FROM featured_project/u);
  });

  it("exposes only private ordered candidates and no public eligibility claim", () => {
    expect(migration).toMatch(
      /CREATE VIEW current_featured_project_candidates/u,
    );
    expect(migration).toMatch(/ordered\.portfolio_project_id/u);
    expect(migration).not.toMatch(
      /CREATE VIEW public_|publicly_eligible|consent_eligible|media_publication_eligible/u,
    );
  });
});
