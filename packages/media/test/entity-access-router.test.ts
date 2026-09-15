import { describe, expect, it, vi } from "vitest";

import {
  createPurposeBoundMediaEntityAccessResolver,
  createServerMediaEntityAccess,
  type PrivateMediaDeliverySnapshot,
} from "../src/index.js";

describe("private media entity access router", () => {
  it("delegates only to the resolver bound to the persisted purpose", async () => {
    const chat = vi.fn(() =>
      Promise.resolve(
        createServerMediaEntityAccess({
          grants: ["CONVERSATION_MEMBER"],
          revision: "chat:2",
        }),
      ),
    );
    const quote = vi.fn(() =>
      Promise.resolve(createServerMediaEntityAccess({ revision: "quote:1" })),
    );
    const router = createPurposeBoundMediaEntityAccessResolver({
      byPurpose: {
        CHAT_IMAGE: { resolvePrivateMediaAccess: chat },
        QUOTE_DOCUMENT: { resolvePrivateMediaAccess: quote },
      },
    });

    await expect(
      router.resolvePrivateMediaAccess(snapshot("CHAT_IMAGE")),
    ).resolves.toMatchObject({
      grants: ["CONVERSATION_MEMBER"],
      revision: "chat:2",
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(quote).not.toHaveBeenCalled();
  });

  it("fails closed for an unbound purpose", async () => {
    const router = createPurposeBoundMediaEntityAccessResolver({
      byPurpose: {},
    });
    await expect(
      router.resolvePrivateMediaAccess(snapshot("JOB_DOCUMENT")),
    ).resolves.toMatchObject({
      grants: [],
      revision: "unsupported:JOB_DOCUMENT",
    });
  });
});

function snapshot(
  purpose: PrivateMediaDeliverySnapshot["asset"]["purpose"],
): PrivateMediaDeliverySnapshot {
  const now = new Date("2026-09-15T20:00:00.000Z");
  return {
    actor: {
      accountState: "ACTIVE",
      userId: "00000000-0000-4000-8000-000000000001" as never,
    },
    asset: {
      id: "00000000-0000-4000-8000-000000000002",
      ownerUserId: "00000000-0000-4000-8000-000000000003" as never,
      provenanceEntityId: "00000000-0000-4000-8000-000000000004",
      provenanceEntityRevision: 1,
      provenanceEntityType: "CONVERSATION_MESSAGE",
      purpose,
      status: "READY",
      updatedAt: now,
    },
    object: {
      contentType: "image/webp",
      createdAt: now,
      id: "00000000-0000-4000-8000-000000000005",
      revokedAt: null,
      role: "CANONICAL",
      storageObject: {
        area: "private",
        key: "private/2026/09/00000000-0000-4000-8000-000000000006" as never,
      },
    },
  };
}
