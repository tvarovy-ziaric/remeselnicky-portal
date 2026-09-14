import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { PLACEHOLDER_ALPHA_TAXONOMY } from "@portal/taxonomy";

import { createProfessionTaxonomyRepository } from "../src/taxonomy-repository.js";

describe("profession taxonomy repository", () => {
  it("installs a complete release transactionally", async () => {
    const release = PLACEHOLDER_ALPHA_TAXONOMY;
    const sql = scriptedSql([
      [{ releaseId: release.releaseId }],
      [],
      [],
      [],
      [],
      [storedRelease(release)],
    ]);
    const repository = createProfessionTaxonomyRepository(sql);
    await expect(repository.installRelease(release)).resolves.toBe("CREATED");
  });

  it("returns unchanged only for the exact same governed checksum", async () => {
    const release = PLACEHOLDER_ALPHA_TAXONOMY;
    const matching = createProfessionTaxonomyRepository(
      scriptedSql([[], [storedRelease(release)]]),
    );
    await expect(matching.installRelease(release)).resolves.toBe("UNCHANGED");

    const conflicting = createProfessionTaxonomyRepository(
      scriptedSql([
        [],
        [{ ...storedRelease(release), checksumSha256: "f".repeat(64) }],
      ]),
    );
    await expect(conflicting.installRelease(release)).rejects.toThrow(
      /conflicts/u,
    );
  });

  it("returns activation idempotency and immutable current entries", async () => {
    const activationId = "00000000-0000-4000-8000-000000001399";
    const sql = scriptedSql([
      [{ activationId }],
      [],
      [
        {
          code: "PROF:SAFE",
          labelSk: "Bezpečné remeslo",
          releaseVersion: 2,
          replacedByCode: null,
          slug: "bezpecne-remeslo",
          state: "ACTIVE",
        },
      ],
    ]);
    const repository = createProfessionTaxonomyRepository(sql);
    const activation = {
      activationId,
      actorReference: "system:taxonomy-release",
      previousReleaseId: null,
      releaseId: "00000000-0000-4000-8000-000000001398",
      reviewReference: "review:taxonomy/approved-2",
    };
    await expect(repository.activateRelease(activation)).resolves.toBe(true);
    await expect(repository.activateRelease(activation)).resolves.toBe(false);
    const current = await repository.listCurrentProfessions();
    expect(current).toHaveLength(1);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current[0])).toBe(true);
  });
});

function storedRelease(release: typeof PLACEHOLDER_ALPHA_TAXONOMY) {
  return {
    checksumSha256: release.checksumSha256,
    contentClass: release.contentClass,
    releaseId: release.releaseId,
    reviewReference: release.reviewReference,
    reviewState: release.reviewState,
    supersedesReleaseId: release.supersedesReleaseId,
    version: release.version,
  };
}

function scriptedSql(responses: readonly unknown[][]): Sql {
  const queue = [...responses];
  const tagged = vi.fn(() =>
    Promise.resolve(queue.shift() ?? []),
  ) as unknown as Sql;
  Object.assign(tagged, {
    begin: (work: (transaction: Sql) => Promise<unknown>) => work(tagged),
  });
  return tagged;
}
