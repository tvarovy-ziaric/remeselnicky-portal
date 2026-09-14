import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfileId,
  PinFeaturedProjectInput,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";

import { createFeaturedProjectRepository } from "../src/featured-project-repository.js";

const actorUserId = "78000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "78000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const projectId = "78000000-0000-4000-8000-000000000003" as PortfolioProjectId;
const commandId = "78000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-14T08:00:00Z");

describe("featured project repository", () => {
  it("pins an owned draft using an exact full snapshot", async () => {
    const sql = appliedPinSql();
    await expect(
      createFeaturedProjectRepository(sql).pin(pinInput()),
    ).resolves.toEqual({
      featured: {
        craftsmanProfileId,
        items: [
          {
            availability: "AVAILABLE",
            portfolioProjectId: projectId,
            position: 1,
            title: "Bezpečný projekt",
          },
        ],
        revision: 1,
        updatedAt: now,
      },
      status: "APPLIED",
    });
    const statements = sql.queries.join("\n");
    expect(statements).toMatch(/record_state = 'DRAFT'/u);
    expect(statements).toMatch(/INSERT INTO featured_project_revisions/u);
  });

  it("fails before replay or writes for a suspended owner", async () => {
    const sql = scriptedSql([
      [{ accountState: "SUSPENDED", ownerUserId: actorUserId }],
    ]);
    await expect(
      createFeaturedProjectRepository(sql).pin(pinInput()),
    ).resolves.toEqual({
      status: "PROFILE_UNAVAILABLE",
    });
    expect(sql.queries.join("\n")).not.toMatch(/featured_project_commands/u);
  });

  it("replays the immutable order but overlays current unavailable state", async () => {
    const first = appliedPinSql();
    await createFeaturedProjectRepository(first).pin(pinInput());
    const fingerprint = first.values
      .flat()
      .find(
        (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value),
      );
    if (typeof fingerprint !== "string")
      throw new Error("Expected fingerprint.");
    const replay = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [
        {
          actorUserId,
          commandKind: "PIN",
          craftsmanProfileId,
          payloadFingerprint: fingerprint,
          resultingRevision: 1,
        },
      ],
      [setRow([projectId], 1)],
      [
        {
          available: false,
          portfolioProjectId: projectId,
          position: 1,
          title: null,
        },
      ],
    ]);
    await expect(
      createFeaturedProjectRepository(replay).pin(pinInput()),
    ).resolves.toEqual({
      featured: {
        craftsmanProfileId,
        items: [
          {
            availability: "UNAVAILABLE",
            portfolioProjectId: projectId,
            position: 1,
            title: null,
          },
        ],
        revision: 1,
        updatedAt: now,
      },
      status: "DEDUPLICATED",
    });
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
  readonly values: unknown[][];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const values: unknown[][] = [];
  const tagged = vi.fn(
    (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      queries.push(strings.join("?"));
      values.push(parameters);
      return Promise.resolve(queue.shift() ?? []);
    },
  ) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
    queries,
    values,
  });
  return tagged;
}

function appliedPinSql(): ScriptedSql {
  return scriptedSql([
    [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
    [],
    [setRow([], 0)],
    [{ id: projectId }],
    [],
    [],
    [],
    [setRow([projectId], 1)],
    [
      {
        available: true,
        portfolioProjectId: projectId,
        position: 1,
        title: "Bezpečný projekt",
      },
    ],
  ]);
}

function pinInput(
  changes: Partial<PinFeaturedProjectInput> = {},
): PinFeaturedProjectInput {
  return {
    actorUserId,
    commandId,
    craftsmanProfileId,
    expectedRevision: 0,
    portfolioProjectId: projectId,
    ...changes,
  };
}

function setRow(projectIds: readonly PortfolioProjectId[], revision: number) {
  return { craftsmanProfileId, projectIds, revision, updatedAt: now };
}
