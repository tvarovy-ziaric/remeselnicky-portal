import { describe, expect, it, vi } from "vitest";

import type { Sql } from "postgres";

import { createPortfolioProjectPhotoUploadAuthorization } from "../src/portfolio-project-upload-repository.js";

const actorUserId = "75200000-0000-4000-8000-000000000001";
const craftsmanProfileId = "75200000-0000-4000-8000-000000000002";
const portfolioProjectId = "75200000-0000-4000-8000-000000000003";
const assetId = "75200000-0000-4000-8000-000000000004";

describe("portfolio project upload authorization", () => {
  it("returns only bounded owner status without storage metadata", async () => {
    const sql = scriptedSql([
      [{ assetId, kind: "IMAGE", status: "READY", storageKey: "ignored" }],
    ]);
    const result =
      await createPortfolioProjectPhotoUploadAuthorization(
        sql,
      ).listOwnedUploads(input());

    expect(result).toEqual([{ assetId, kind: "IMAGE", status: "READY" }]);
    expect(JSON.stringify(result)).not.toMatch(/storage|filename|sha256/iu);
    expect(sql.queries.join("\n")).toMatch(
      /actor\.account_state = 'ACTIVE'[\s\S]*profile\.id = [\s\S]*project\.id =/u,
    );
    expect(sql.queries.join("\n")).not.toMatch(/storage_objects/u);
  });

  it("fails before SQL for malformed identities", async () => {
    const sql = scriptedSql([]);
    await expect(
      createPortfolioProjectPhotoUploadAuthorization(sql).listOwnedUploads({
        ...input(),
        actorUserId: "not-a-user",
      }),
    ).resolves.toEqual([]);
    expect(sql.queries).toEqual([]);
  });

  it("delegates upload preparation to the exact active project revision", async () => {
    const sql = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [{ recordState: "DRAFT", revision: 3 }],
    ]);
    await expect(
      createPortfolioProjectPhotoUploadAuthorization(sql).prepareUpload({
        ...input(),
        expectedProjectRevision: 3,
      }),
    ).resolves.toMatchObject({
      provenance: {
        entityId: portfolioProjectId,
        entityRevision: 3,
        entityType: "PORTFOLIO_PROJECT",
      },
      purpose: "PORTFOLIO_IMAGE",
      status: "AUTHORIZED",
    });
  });
});

interface ScriptedSql extends Sql {
  readonly queries: string[];
}

function scriptedSql(responses: readonly unknown[][]): ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const tagged = vi.fn((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as ScriptedSql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
    queries,
  });
  return tagged;
}

function input() {
  return { actorUserId, craftsmanProfileId, portfolioProjectId };
}
