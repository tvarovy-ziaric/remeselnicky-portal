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
      [
        {
          assetId: "95200000-0000-4000-8000-000000000006",
          createdAt: new Date("2026-09-15T08:00:01Z"),
          kind: "DOCUMENT",
          messageId,
          status: "PROCESSING",
        },
      ],
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
          attachments: [{ kind: "PDF", status: "PROCESSING" }],
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
    const fixture = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [participant("READ_ONLY")],
      [],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Neskorá správa",
        commandId,
        conversationId,
      }),
    ).resolves.toEqual({ status: "READ_ONLY" });
    expect(fixture.statements[1]).toContain("FOR UPDATE OF state");
    expect(fixture.statements[2]).toContain("account_state = 'ACTIVE'");
    expect(fixture.statements[3]).toContain("FROM conversations conversation");
    expect(fixture.statements[3]).toContain("FOR UPDATE OF invitation");
  });

  it("returns the same uniform absence for a competitor", async () => {
    const fixture = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [],
    ]);
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
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
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

  it("uses only a server-resolved PRE_CONFIRM stage and retains no blocked command", async () => {
    const fixture = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [participant("WRITABLE")],
      [],
      [{ stage: "PRE_CONFIRM" }],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Napíšte mi na meno@example.sk",
        commandId,
        conversationId,
      }),
    ).resolves.toEqual({ status: "BLOCKED_BY_CONTACT_POLICY" });
    expect(fixture.statements).toHaveLength(7);
    expect(fixture.statements.at(-1)).toContain(
      "conversation_message_policy_stage",
    );
    expect(fixture.statements.join("\n")).not.toContain(
      "INSERT INTO conversation_message_commands",
    );
  });

  it("allows ordinary content at POST_CONFIRM without client-authored policy fields", async () => {
    const fixture = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [participant("WRITABLE")],
      [],
      [{ stage: "POST_CONFIRM" }],
      [{ resultingMessageId: messageId }],
      [],
      [humanEntry()],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Kontakt po potvrdení: meno@example.sk",
        commandId,
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "SENT" });
    const insert = fixture.statements.find((statement) =>
      statement.includes("INSERT INTO conversation_message_commands"),
    );
    expect(insert).toBeDefined();
    expect(insert).not.toMatch(/policy_stage|policy_version/u);
  });

  it("replays an accepted command before evaluating a newer policy", async () => {
    const body = "Pôvodne prijatá správa";
    const fixture = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [participant("WRITABLE")],
      [
        {
          actorUserId,
          conversationId,
          payloadFingerprint: messageFingerprint(body),
          resultingMessageId: messageId,
        },
      ],
      [humanEntry()],
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body,
        commandId,
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });
    expect(fixture.statements.join("\n")).not.toContain(
      "conversation_message_policy_stage",
    );
  });

  it("fails closed when the server policy stage is missing or corrupt", async () => {
    for (const stage of [null, "UNKNOWN"]) {
      const fixture = scriptedSql([
        [],
        [],
        [{ id: actorUserId }],
        [{ id: conversationId }],
        [participant("WRITABLE")],
        [],
        [{ stage }],
      ]);
      await expect(
        createConversationChatRepository(fixture.sql).sendMessage({
          actorUserId,
          body: "Bežná správa",
          commandId,
          conversationId,
        }),
      ).rejects.toThrow("policy stage unavailable");
    }
  });

  it("maps only the fixed database policy rejection to the generic domain result", async () => {
    const fixture = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [participant("WRITABLE")],
      [],
      [{ stage: "POST_CONFIRM" }],
      new Error("message blocked by pre-confirmation contact policy"),
    ]);
    await expect(
      createConversationChatRepository(fixture.sql).sendMessage({
        actorUserId,
        body: "Bežná správa",
        commandId,
        conversationId,
      }),
    ).resolves.toEqual({ status: "BLOCKED_BY_CONTACT_POLICY" });

    const unexpected = scriptedSql([
      [],
      [],
      [{ id: actorUserId }],
      [{ id: conversationId }],
      [participant("WRITABLE")],
      [],
      [{ stage: "POST_CONFIRM" }],
      new Error("syntax failure"),
    ]);
    await expect(
      createConversationChatRepository(unexpected.sql).sendMessage({
        actorUserId,
        body: "Bežná správa",
        commandId,
        conversationId,
      }),
    ).rejects.toThrow("syntax failure");
  });

  it("fails closed on a corrupt timeline row", async () => {
    const fixture = scriptedSql([
      [participant("WRITABLE")],
      [],
      [],
      [{ ...humanEntry(), body: null }],
      [],
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
    hiddenByModeration: false,
    replyToMessageId: null,
    sequence: 2,
    systemEvent: null,
  };
}

function messageFingerprint(body: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId,
        body,
        conversationId,
        replyToMessageId: null,
      }),
    )
    .digest("hex");
}

function scriptedSql(results: Array<Error | unknown[]>) {
  const statements: string[] = [];
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    const result = results.shift() ?? [];
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
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
import { createHash } from "node:crypto";
