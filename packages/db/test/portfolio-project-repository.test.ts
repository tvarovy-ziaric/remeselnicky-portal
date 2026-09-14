import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfessionId,
  CraftsmanProfileId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";

import { createPortfolioProjectRepository } from "../src/portfolio-project-repository.js";

const actorUserId = "73000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "73000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const portfolioProjectId =
  "73000000-0000-4000-8000-000000000003" as PortfolioProjectId;
const professionId =
  "73000000-0000-4000-8000-000000000004" as CraftsmanProfessionId;

describe("portfolio project repository", () => {
  it("creates only an immutable self-declared private draft snapshot", async () => {
    const sql = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [],
      [],
      [{ professions: 1, skills: 0, specializations: 0 }],
      [],
      [],
      [],
      [projectRow()],
    ]);
    await expect(
      createPortfolioProjectRepository(sql).create(createInput()),
    ).resolves.toMatchObject({
      project: {
        evidenceStatus: "UNVERIFIED",
        provenanceKind: "SELF_DECLARED",
        recordState: "DRAFT",
      },
      status: "APPLIED",
    });
    const statements = sql.queries.join("\n");
    expect(statements).toMatch(
      /INSERT INTO portfolio_projects[\s\S]*'SELF_DECLARED'[\s\S]*'DRAFT'/u,
    );
    expect(statements).toMatch(/INSERT INTO portfolio_project_revisions/u);
    expect(statements).not.toMatch(/job_participant|source_job|is_public/u);
  });

  it("fails closed at the owner boundary before replay or writes", async () => {
    const sql = scriptedSql([
      [{ accountState: "SUSPENDED", ownerUserId: actorUserId }],
    ]);
    await expect(
      createPortfolioProjectRepository(sql).create(createInput()),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries.join("\n")).not.toMatch(
      /portfolio_project_commands|INSERT INTO portfolio_projects/u,
    );
  });

  it("reads deduplicated results from the immutable command revision", async () => {
    const input = createInput();
    const first = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [],
      [],
      [{ professions: 1, skills: 0, specializations: 0 }],
      [],
      [],
      [],
      [projectRow()],
    ]);
    await createPortfolioProjectRepository(first).create(input);
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
          commandKind: "CREATE",
          craftsmanProfileId,
          payloadFingerprint: fingerprint,
          portfolioProjectId,
          resultingRevision: 1,
        },
      ],
      [projectRow({ revision: 1, title: "Pôvodný názov" })],
    ]);
    await expect(
      createPortfolioProjectRepository(replay).create(input),
    ).resolves.toMatchObject({
      project: { revision: 1, title: "Pôvodný názov" },
      status: "DEDUPLICATED",
    });
    expect(replay.queries.join("\n")).toMatch(
      /FROM portfolio_project_revisions revision[\s\S]*revision\.command_id/u,
    );
  });

  it("fuses active-owner authorization into the private project list", async () => {
    const sql = scriptedSql([[projectRow()]]);
    await expect(
      createPortfolioProjectRepository(sql).listOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toHaveLength(1);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]).toMatch(
      /FROM current_portfolio_projects project[\s\S]*JOIN users owner[\s\S]*profile\.owner_user_id[\s\S]*owner\.account_state = 'ACTIVE'/u,
    );

    await expect(
      createPortfolioProjectRepository(scriptedSql([[]])).listOwned({
        actorUserId,
        craftsmanProfileId,
      }),
    ).resolves.toEqual([]);
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

function createInput() {
  return {
    actorUserId,
    commandId: "73000000-0000-4000-8000-000000000005",
    contribution: null,
    craftsmanProfileId,
    districtCode: null,
    durationUnit: "DAYS" as const,
    durationValue: 3,
    indicativePriceMaxCents: 150_000,
    indicativePriceMinCents: 100_000,
    materialsAndTechnologies: null,
    municipalityCode: null,
    portfolioProjectId,
    problem: null,
    professionIds: [professionId],
    shortDescription: "Súkromný opis staršej realizácie",
    skillIds: [],
    solution: null,
    specializationIds: [],
    title: "Staršia realizácia",
  };
}

function projectRow(changes: Partial<ReturnType<typeof baseProjectRow>> = {}) {
  return { ...baseProjectRow(), ...changes };
}

function baseProjectRow() {
  const createdAt = new Date("2026-09-14T08:00:00Z");
  return {
    authorUserId: actorUserId,
    contribution: null,
    craftsmanProfileId,
    createdAt,
    currency: "EUR",
    districtCode: null,
    durationUnit: "DAYS",
    durationValue: 3,
    evidenceStatus: "UNVERIFIED",
    id: portfolioProjectId,
    indicativePriceMaxCents: "150000",
    indicativePriceMinCents: "100000",
    materialsAndTechnologies: null,
    municipalityCode: null,
    problem: null,
    professionIds: [professionId],
    provenanceKind: "SELF_DECLARED",
    recordState: "DRAFT",
    revision: 1,
    shortDescription: "Súkromný opis staršej realizácie",
    skillIds: [],
    solution: null,
    specializationIds: [],
    title: "Staršia realizácia",
    updatedAt: createdAt,
  };
}
