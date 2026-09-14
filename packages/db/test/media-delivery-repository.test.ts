import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createPrivateMediaDeliveryRepository } from "../src/index.js";

const actorUserId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const mediaAssetId = "33333333-3333-4333-8333-333333333333";

describe("private media delivery repository", () => {
  it("loads a narrow current actor + canonical object projection", async () => {
    const timestamp = new Date("2026-09-14T12:00:00.000Z");
    const execute = vi.fn().mockResolvedValue([
      {
        actorAccountState: "ACTIVE",
        actorUserId,
        assetId: mediaAssetId,
        assetStatus: "READY",
        assetUpdatedAt: timestamp,
        contentType: "application/pdf",
        objectCreatedAt: timestamp,
        objectId: "44444444-4444-4444-8444-444444444444",
        objectRevokedAt: null,
        ownerUserId,
        provenanceEntityId: "55555555-5555-4555-8555-555555555555",
        provenanceEntityRevision: 3,
        provenanceEntityType: "QUOTE_REVISION",
        purpose: "QUOTE_DOCUMENT",
        storageArea: "private",
        storageKey: "private/2026/09/66666666-6666-4666-8666-666666666666",
      },
    ]);
    const repository = createPrivateMediaDeliveryRepository(
      execute as unknown as Sql,
    );

    const result = await repository.loadPrivateDeliverySnapshot({
      actorUserId,
      mediaAssetId,
    });

    expect(result).toEqual({
      actor: { accountState: "ACTIVE", userId: actorUserId },
      asset: {
        id: mediaAssetId,
        ownerUserId,
        provenanceEntityId: "55555555-5555-4555-8555-555555555555",
        provenanceEntityRevision: 3,
        provenanceEntityType: "QUOTE_REVISION",
        purpose: "QUOTE_DOCUMENT",
        status: "READY",
        updatedAt: timestamp,
      },
      object: {
        contentType: "application/pdf",
        createdAt: timestamp,
        id: "44444444-4444-4444-8444-444444444444",
        revokedAt: null,
        role: "CANONICAL",
        storageObject: {
          area: "private",
          key: "private/2026/09/66666666-6666-4666-8666-666666666666",
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed before SQL for malformed actor and asset identifiers", async () => {
    const execute = vi.fn();
    const repository = createPrivateMediaDeliveryRepository(
      execute as unknown as Sql,
    );

    await expect(
      repository.loadPrivateDeliverySnapshot({
        actorUserId: "../../../other-user",
        mediaAssetId,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.loadPrivateDeliverySnapshot({
        actorUserId,
        mediaAssetId: "private/storage/key",
      }),
    ).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns no distinguishable projection when actor, asset or canonical object is absent", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repository = createPrivateMediaDeliveryRepository(
      execute as unknown as Sql,
    );
    await expect(
      repository.loadPrivateDeliverySnapshot({ actorUserId, mediaAssetId }),
    ).resolves.toBeNull();
  });
});
