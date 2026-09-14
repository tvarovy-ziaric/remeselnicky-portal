import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  portfolioCollaborationCommands,
  portfolioCollaborationRevisions,
  portfolioCollaborations,
  PORTFOLIO_COLLABORATION_COMMAND_KINDS,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0026_portfolio_collaborations.sql", import.meta.url),
  ),
  "utf8",
);

describe("portfolio collaborator schema", () => {
  it("models explicit invite, confirmation and independent visibility commands", () => {
    expect(PORTFOLIO_COLLABORATION_COMMAND_KINDS).toEqual([
      "INVITE",
      "EDIT_PENDING",
      "AUTHOR_WITHDRAW",
      "COLLABORATOR_ACCEPT",
      "COLLABORATOR_DECLINE",
      "COLLABORATOR_WITHDRAW",
      "HIDE",
      "SHOW",
    ]);
    expect(
      getTableConfig(portfolioCollaborations).columns.map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        "portfolio_project_id",
        "author_profile_id",
        "collaborator_profile_id",
        "state",
        "visibility",
        "role",
        "contribution",
        "accepted_at",
      ]),
    );
  });

  it("keeps accepted provenance in immutable command/revision history", () => {
    expect(
      getTableConfig(portfolioCollaborationRevisions).uniqueConstraints,
    ).toHaveLength(1);
    expect(migration).toContain("NEW.accepted_at := command.occurred_at");
    expect(migration).toContain("NEW.terminal_at := command.occurred_at");
    expect(migration).toContain("collaboration history is append-only");
    expect(migration).toContain(
      "portfolio collaboration command requires exact head and revision effects",
    );
    expect(migration).toContain(
      "NEW.resulting_revision := current.revision + 1",
    );
  });

  it("enforces active object owners and prevents author-side acceptance", () => {
    expect(migration).toContain(
      "active portfolio author collaboration context required",
    );
    expect(migration).toContain("active invited collaborator required");
    expect(migration).toContain("actor_kind = 'COLLABORATOR'");
    expect(migration).toContain("'COLLABORATOR_ACCEPT'");
    expect(migration).toContain(
      "portfolio_collaboration_commands_content_shape",
    );
    expect(migration).toContain("AND requested_role IS NULL");
    expect(migration).toContain("FOR UPDATE OF profile, owner");
    const invitationLock = migration.slice(
      migration.indexOf("lock_portfolio_collaboration_invitation"),
      migration.indexOf("lock_portfolio_collaboration_collaborator"),
    );
    expect(invitationLock.indexOf("ORDER BY profile.id")).toBeLessThan(
      invitationLock.indexOf("FROM portfolio_projects"),
    );
  });

  it("uses privacy-safe public text and contains no invented Job provenance", () => {
    const columns = [
      ...getTableConfig(portfolioCollaborations).columns,
      ...getTableConfig(portfolioCollaborationCommands).columns,
    ].map(({ name }) => name);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "job_id",
        "job_participant_id",
        "suggestion_reference",
        "email",
        "phone",
        "exact_address",
        "user_name",
      ]),
    );
    expect(migration).toContain("portfolio_project_public_text_safe(role)");
    expect(migration).toContain(
      "Off-platform attribution never represents JobParticipant or verified Job provenance",
    );
  });

  it("exposes only current candidates for the later final public intersection", () => {
    expect(migration).toContain(
      "CREATE VIEW current_portfolio_collaboration_candidates",
    );
    expect(migration).toContain("collaboration.state = 'ACCEPTED'");
    expect(migration).toContain("collaboration.visibility = 'VISIBLE'");
    expect(migration.match(/effectively_public/gu)).toHaveLength(2);
    expect(migration).toContain("not complete public eligibility");
  });
});
