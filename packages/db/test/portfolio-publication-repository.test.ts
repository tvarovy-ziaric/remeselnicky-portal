import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  CraftsmanProfileId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import { asStorageObjectKey } from "@portal/media";
import type { Sql } from "postgres";

import { createPortfolioPublicationRepository } from "../src/portfolio-publication-repository.js";

const actorUserId = "7a000000-0000-4000-8000-000000000001" as UserId;
const craftsmanProfileId =
  "7a000000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const portfolioProjectId =
  "7a000000-0000-4000-8000-000000000003" as PortfolioProjectId;
const publicStorageKey =
  "public-derivative/2026/09/7a000000-0000-4000-8000-000000000004";

describe("portfolio publication repository", () => {
  it("allows an active owner to hide a currently public archived project", async () => {
    const commandId = randomUUID();
    const objectId = randomUUID();
    const sql = scriptedSql([
      [{ ownerUserId: actorUserId }],
      [],
      [
        {
          authorUserId: actorUserId,
          craftsmanProfileId,
          projectRevision: 2,
          provenanceKind: "SELF_DECLARED",
          recordState: "ARCHIVED",
        },
      ],
      [{ photoSetRevision: 3 }],
      [
        {
          craftsmanProfileId,
          publicationRevision: 1,
          state: "PUBLIC",
        },
      ],
      [],
      [],
      [],
      [
        {
          objectId,
          storageArea: "public-derivative",
          storageKey: publicStorageKey,
        },
      ],
    ]);

    await expect(
      createPortfolioPublicationRepository(sql).hide({
        actorUserId,
        commandId,
        craftsmanProfileId,
        expectedPhotoSetRevision: 3,
        expectedProjectRevision: 2,
        expectedPublicationRevision: 1,
        portfolioProjectId,
      }),
    ).resolves.toEqual({
      pendingRevocations: [
        {
          objectId,
          publicationRevision: 2,
          storageObject: {
            area: "public-derivative",
            key: asStorageObjectKey(publicStorageKey),
          },
        },
      ],
      snapshot: {
        photoSetRevision: 3,
        projectRevision: 2,
        publicationRevision: 2,
        state: "HIDDEN",
      },
      status: "APPLIED",
    });
  });

  it("rejects malformed or non-contiguous derivatives before opening a transaction", () => {
    const sql = scriptedSql([]);
    const repository = createPortfolioPublicationRepository(sql);
    expect(() =>
      repository.finalizePublish({
        command: {
          actorUserId,
          commandId: randomUUID(),
          craftsmanProfileId,
          expectedPhotoSetRevision: 1,
          expectedProjectRevision: 1,
          expectedPublicationRevision: 0,
          portfolioProjectId,
        },
        derivatives: [
          {
            attachmentId: randomUUID(),
            byteSize: 10,
            canonicalHeight: 900,
            canonicalWidth: 1200,
            contentSha256: "a".repeat(64),
            displayOrder: 2,
            mediaAssetId: randomUUID(),
            phase: "OTHER",
            publicObject: {
              area: "public-derivative",
              key: asStorageObjectKey(publicStorageKey),
            },
            publicObjectId: randomUUID(),
            publicUrl: new URL("https://media.example.test/object.webp"),
            sourceObjectId: randomUUID(),
          },
        ],
      }),
    ).toThrow(/Stored public derivative is invalid/u);
    expect(sql.queries).toEqual([]);
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
