import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  ConversationChatIdempotencyError,
  type ConversationId,
  type UserId,
} from "@portal/domain";

import { createConversationChatRepository } from "../src/conversation-chat-repository.js";

const actorUserId = "95200000-0000-4000-8000-000000000001" as UserId;
const counterpartUserId = "95200000-0000-4000-8000-000000000002";
const conversationId = "95200000-0000-4000-8000-000000000003" as ConversationId;
const commandId = "95200000-0000-4000-8000-000000000004";
const messageId = "95200000-0000-4000-8000-000000000005";

describe("conversation chat repository", () => {
  it("reads only the exact ACTIVE participant and derives unread/read facts", async () => {
    const fixture = scriptedSql([
      [participant("WRITABLE")],
      [],
      [
        {
          archived: false,
          lastReadAt: new Date("2026-09-15T08:01:00Z"),
          lastReadSequence: 2,
          muted: false,
          revision: 1,
        },
      ],
      [humanEntry()],
      [{ count: 1 }],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).readTimeline({
        actorUserId,
        conversationId,
      }),
    ).resolves.toMatchObject({
      entries: [
        {
          author: "SELF",
          readByCounterpart: true,
          sequence: 2,
        },
      ],
      participantState: { revision: 0 },
      unreadCount: 1,
    });
    expect(fixture.statements[0]).toContain("actor.account_state = 'ACTIVE'");
    expect(fixture.statements[0]).toContain(
      "customer.owner_user_id = actor.id",
    );
    expect(fixture.statements[0]).toContain(
      "craftsman.owner_user_id = actor.id",
    );
    expect(fixture.statements.join("\n")).not.toMatch(
      /email|phone|storage_key/iu,
    );
  });

  it("keeps terminal conversations readable but rejects a new message", async () => {
    const fixture = scriptedSql([[], [participant("READ_ONLY")], []]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Neskorá správa",
        commandId,
        conversationId,
      }),
    ).resolves.toEqual({ status: "READ_ONLY" });
    expect(fixture.statements).toHaveLength(3);
  });

  it("returns the same uniform absence for a competitor", async () => {
    const fixture = scriptedSql([[], []]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Cudzia správa",
        commandId,
        conversationId,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });

  it("rejects command-id reuse with another intent after reauthorization", async () => {
    const fixture = scriptedSql([
      [],
      [participant("WRITABLE")],
      [
        {
          actorUserId,
          conversationId,
          payloadFingerprint: "0".repeat(64),
          resultingMessageId: messageId,
        },
      ],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Nový úmysel",
        commandId,
        conversationId,
      }),
    ).rejects.toBeInstanceOf(ConversationChatIdempotencyError);
  });

  it("fails closed on a corrupt timeline row", async () => {
    const fixture = scriptedSql([
      [participant("WRITABLE")],
      [],
      [],
      [{ ...humanEntry(), body: null }],
      [{ count: 0 }],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).readTimeline({
        actorUserId,
        conversationId,
      }),
    ).rejects.toThrow("Corrupt conversation human message");
  });
});

function participant(access: "READ_ONLY" | "WRITABLE") {
  return { access, counterpartUserId, participantRole: "CUSTOMER" };
}

function humanEntry() {
  return {
    authorRole: "CUSTOMER",
    authorUserId: actorUserId,
    body: "Dobrý deň",
    conversationId,
    createdAt: new Date("2026-09-15T08:00:00Z"),
    id: messageId,
    kind: "HUMAN_MESSAGE",
    replyToMessageId: null,
    sequence: 2,
    systemEvent: null,
  };
}

function scriptedSql(results: unknown[][]) {
  const statements: string[] = [];
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Sql;
  Object.assign(query, {
    begin: (
      optionsOrCallback: string | ((transaction: Sql) => Promise<unknown>),
      maybeCallback?: (transaction: Sql) => Promise<unknown>,
    ) =>
      (typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : maybeCallback)?.(query),
  });
  return { sql: query, statements };
}
