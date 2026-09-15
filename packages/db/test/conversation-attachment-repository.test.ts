import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createConversationAttachmentMediaAccessResolver,
  createConversationAttachmentUploadAuthorization,
} from "../src/conversation-attachment-repository.js";

const actorUserId = "9f200000-0000-4000-8000-000000000001";
const conversationId = "9f200000-0000-4000-8000-000000000002";
const messageId = "9f200000-0000-4000-8000-000000000003";
const mediaAssetId = "9f200000-0000-4000-8000-000000000004";

describe("conversation attachment repository", () => {
  it("locks and revalidates the exact ACTIVE writable message author", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [{ invitationId: "9f200000-0000-4000-8000-000000000009" }],
      [{ id: "9f200000-0000-4000-8000-000000000009" }],
      [{ sequence: 4 }],
      [{ imageCount: 2, totalCount: 3 }],
    ]);
    await expect(
      createConversationAttachmentUploadAuthorization(
        fixture.sql,
      ).prepareUpload({
        actorUserId,
        conversationId,
        mediaKind: "IMAGE",
        messageId,
      }),
    ).resolves.toMatchObject({
      provenance: {
        entityId: messageId,
        entityRevision: 4,
        entityType: "CONVERSATION_MESSAGE",
      },
      purpose: "CHAT_IMAGE",
      status: "AUTHORIZED",
    });
    expect(fixture.statements[0]).toContain("account_state = 'ACTIVE'");
    expect(fixture.statements[2]).toContain("FROM job_invitations");
    expect(fixture.statements[2]).toContain("FOR UPDATE");
    expect(fixture.statements[3]).toContain(
      "current.access_state = 'WRITABLE'",
    );
    expect(fixture.statements[3]).toContain(
      "message.author_user_id = actor.id",
    );
    expect(fixture.statements[3]).toContain(
      "FOR UPDATE OF conversation, message",
    );
  });

  it("counts all historical attempts and fails closed at either technical bound", async () => {
    const atImageLimit = scriptedSql([
      [{ id: actorUserId }],
      [{ invitationId: "9f200000-0000-4000-8000-000000000009" }],
      [{ id: "9f200000-0000-4000-8000-000000000009" }],
      [{ sequence: 4 }],
      [{ imageCount: 5, totalCount: 5 }],
    ]);
    await expect(
      createConversationAttachmentUploadAuthorization(
        atImageLimit.sql,
      ).prepareUpload({
        actorUserId,
        conversationId,
        mediaKind: "IMAGE",
        messageId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(atImageLimit.statements[4]).not.toContain("status = 'READY'");

    const atTotalLimit = scriptedSql([
      [{ id: actorUserId }],
      [{ invitationId: "9f200000-0000-4000-8000-000000000009" }],
      [{ id: "9f200000-0000-4000-8000-000000000009" }],
      [{ sequence: 4 }],
      [{ imageCount: 0, totalCount: 10 }],
    ]);
    await expect(
      createConversationAttachmentUploadAuthorization(
        atTotalLimit.sql,
      ).prepareUpload({
        actorUserId,
        conversationId,
        mediaKind: "PDF",
        messageId,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
  });

  it("resolves delivery for an ACTIVE current member, including READ_ONLY history", async () => {
    const fixture = scriptedSql([
      [
        {
          accessState: "READ_ONLY",
          actorStateChangedAt: new Date("2026-09-15T11:00:00Z"),
          conversationId,
          invitationChangedAt: new Date("2026-09-15T10:00:00Z"),
          invitationRevision: 3,
        },
      ],
    ]);
    const resolver = createConversationAttachmentMediaAccessResolver(
      fixture.sql,
    );
    await expect(
      resolver.resolvePrivateMediaAccess(snapshot()),
    ).resolves.toMatchObject({ grants: ["CONVERSATION_MEMBER"] });
    expect(fixture.statements[0]).toContain("actor.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain(
      "customer.owner_user_id = actor.id",
    );
    expect(fixture.statements[0]).toContain(
      "craftsman.owner_user_id = actor.id",
    );
    expect(fixture.statements[0]).not.toContain("storage_key");
  });

  it("returns an unprivileged context for wrong provenance or no current relation", async () => {
    const fixture = scriptedSql([[]]);
    const resolver = createConversationAttachmentMediaAccessResolver(
      fixture.sql,
    );
    await expect(
      resolver.resolvePrivateMediaAccess(snapshot()),
    ).resolves.toMatchObject({ grants: [] });
    await expect(
      resolver.resolvePrivateMediaAccess({
        ...snapshot(),
        asset: { ...snapshot().asset, provenanceEntityType: "JOB" },
      }),
    ).resolves.toMatchObject({ grants: [] });
  });
});

function snapshot() {
  return {
    actor: { accountState: "ACTIVE" as const, userId: actorUserId as never },
    asset: {
      id: mediaAssetId,
      ownerUserId: actorUserId as never,
      provenanceEntityId: messageId,
      provenanceEntityRevision: 4,
      provenanceEntityType: "CONVERSATION_MESSAGE" as const,
      purpose: "CHAT_IMAGE" as const,
      status: "READY" as const,
      updatedAt: new Date("2026-09-15T12:00:00Z"),
    },
    object: {
      contentType: "image/webp",
      createdAt: new Date("2026-09-15T12:00:00Z"),
      id: "9f200000-0000-4000-8000-000000000005",
      revokedAt: null,
      role: "CANONICAL" as const,
      storageObject: {
        area: "private" as const,
        key: "private/2026/09/9f200000-0000-4000-8000-000000000006" as never,
      },
    },
  };
}

function scriptedSql(results: unknown[][]) {
  const statements: string[] = [];
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Sql;
  Object.assign(query, {
    begin: (callback: (transaction: Sql) => Promise<unknown>) =>
      callback(query),
  });
  return { sql: query, statements };
}
