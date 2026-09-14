import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfileId,
  PortfolioProjectId,
  PortfolioProjectPhotoAttachmentId,
  UserId,
} from "@portal/domain";
import type { Sql } from "postgres";

import {
  createPortfolioProjectPhotoRepository,
  preparePortfolioPhotoUpload,
} from "../src/portfolio-project-media-repository.js";

const actorUserId = "75000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "75000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const portfolioProjectId =
  "75000000-0000-4000-8000-000000000003" as PortfolioProjectId;
const attachmentId =
  "75000000-0000-4000-8000-000000000004" as PortfolioProjectPhotoAttachmentId;
const mediaAssetId = "75000000-0000-4000-8000-000000000005";
const commandId = "75000000-0000-4000-8000-000000000006";
const now = new Date("2026-09-14T08:00:00Z");

describe("portfolio project photo repository", () => {
  it("attaches only canonical metadata and returns no storage material", async () => {
    const sql = attachSql();
    await expect(
      createPortfolioProjectPhotoRepository(sql).attach(attachInput()),
    ).resolves.toMatchObject({
      photoSet: {
        photos: [
          {
            attachmentId,
            mediaAssetId,
            order: 1,
            phase: "OTHER",
            state: "ACTIVE",
          },
        ],
        revision: 1,
      },
      status: "APPLIED",
    });
    const statements = sql.queries.join("\n");
    expect(statements).toMatch(/FOR UPDATE OF asset, object/u);
    expect(statements).toMatch(/INSERT INTO portfolio_photo_revision_items/u);
    expect(
      JSON.stringify(
        await createPortfolioProjectPhotoRepository(
          scriptedSql([
            [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
            [projectLock()],
            [{ revision: 1 }],
            [photoHeader(1)],
            [photoRow()],
          ]),
        ).listOwned(listInput()),
      ),
    ).not.toMatch(/storage|filename|sha256/iu);
  });

  it("fails closed before replay or writes for a suspended owner", async () => {
    const sql = scriptedSql([
      [{ accountState: "SUSPENDED", ownerUserId: actorUserId }],
    ]);
    await expect(
      createPortfolioProjectPhotoRepository(sql).attach(attachInput()),
    ).resolves.toEqual({ status: "PROFILE_UNAVAILABLE" });
    expect(sql.queries.join("\n")).not.toMatch(/portfolio_photo_commands/u);
  });

  it("replays the exact historical photo revision", async () => {
    const first = attachSql();
    await createPortfolioProjectPhotoRepository(first).attach(attachInput());
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
          commandKind: "ATTACH",
          craftsmanProfileId,
          payloadFingerprint: fingerprint,
          portfolioProjectId,
          resultingRevision: 1,
        },
      ],
      [photoHeader(1)],
      [photoRow({ phase: "OTHER", state: "ACTIVE" })],
    ]);
    await expect(
      createPortfolioProjectPhotoRepository(replay).attach(attachInput()),
    ).resolves.toMatchObject({
      photoSet: { revision: 1 },
      status: "DEDUPLICATED",
    });
    expect(replay.queries.join("\n")).toMatch(
      /portfolio_photo_revisions[\s\S]*revision =/u,
    );
  });

  it("mints trusted upload provenance only at the active exact-revision owner boundary", async () => {
    const allowed = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [{ recordState: "HIDDEN", revision: 3 }],
    ]);
    await expect(
      preparePortfolioPhotoUpload(allowed, {
        ...listInput(),
        expectedProjectRevision: 3,
      }),
    ).resolves.toMatchObject({
      kind: "IMAGE",
      provenance: {
        entityId: portfolioProjectId,
        entityRevision: 3,
        entityType: "PORTFOLIO_PROJECT",
      },
      purpose: "PORTFOLIO_IMAGE",
      status: "AUTHORIZED",
    });
    const denied = scriptedSql([
      [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
      [{ recordState: "DRAFT", revision: 4 }],
    ]);
    await expect(
      preparePortfolioPhotoUpload(denied, {
        ...listInput(),
        expectedProjectRevision: 3,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
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

function attachSql(): ScriptedSql {
  return scriptedSql([
    [{ accountState: "ACTIVE", ownerUserId: actorUserId }],
    [],
    [projectLock()],
    [{ revision: 0 }],
    [
      {
        canonicalHeight: 900,
        canonicalWidth: 1200,
        capturedAt: null,
        id: mediaAssetId,
      },
    ],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [photoHeader(1)],
    [photoRow()],
  ]);
}

function attachInput() {
  return {
    ...listInput(),
    attachmentId,
    commandId,
    expectedRevision: 0,
    mediaAssetId,
  };
}

function listInput() {
  return { actorUserId, craftsmanProfileId, portfolioProjectId };
}

function projectLock() {
  return {
    authorUserId: actorUserId,
    craftsmanProfileId,
    portfolioProjectId,
    projectRecordState: "DRAFT",
    projectRevision: 1,
  };
}

function photoHeader(revision: number) {
  return {
    attachedAt: null,
    attachmentId: null,
    canonicalHeight: null,
    canonicalWidth: null,
    capturedAt: null,
    craftsmanProfileId,
    displayOrder: null,
    mediaAssetId: null,
    phase: null,
    portfolioProjectId,
    revision,
    state: null,
    updatedAt: now,
  };
}

function photoRow(changes: Record<string, unknown> = {}) {
  return {
    attachedAt: now,
    attachmentId,
    canonicalHeight: 900,
    canonicalWidth: 1200,
    capturedAt: null,
    displayOrder: 1,
    mediaAssetId,
    phase: "OTHER",
    state: "ACTIVE",
    ...changes,
  };
}
