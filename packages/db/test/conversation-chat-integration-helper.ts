import { randomUUID } from "node:crypto";

import {
  ConversationChatIdempotencyError,
  type ConversationId,
  type UserId,
} from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createConversationChatRepository } from "../src/conversation-chat-repository.js";

interface Fixture {
  readonly conversationId: ConversationId;
  readonly craftsmanOwnerId: UserId;
  readonly customerOwnerId: UserId;
}

export async function runConversationChatIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await loadFixture(sql, "WRITABLE");
  const chat = createConversationChatRepository(sql);
  const initial = await chat.readTimeline({
    actorUserId: fixture.customerOwnerId,
    conversationId: fixture.conversationId,
  });
  expect(initial).toMatchObject({
    entries: [
      expect.objectContaining({
        author: "SYSTEM",
        kind: "SYSTEM_EVENT",
        hiddenByModeration: false,
        sequence: 1,
        systemEvent: "ENGAGEMENT",
      }),
    ],
    participantState: { archived: false, muted: false, revision: 0 },
    unreadCount: 0,
  });

  const customerCommandId = randomUUID();
  const customerSent = await chat.sendMessage({
    actorUserId: fixture.customerOwnerId,
    body: "Dobrý deň, môžete upresniť možný termín?",
    commandId: customerCommandId,
    conversationId: fixture.conversationId,
  });
  expect(customerSent).toMatchObject({
    entry: { author: "SELF", sequence: 2 },
    status: "SENT",
  });
  if (!("entry" in customerSent)) throw new Error("Expected sent message.");

  await expect(
    chat.sendMessage({
      actorUserId: fixture.customerOwnerId,
      body: "Dobrý deň, môžete upresniť možný termín?",
      commandId: customerCommandId,
      conversationId: fixture.conversationId,
    }),
  ).resolves.toMatchObject({
    entry: { id: customerSent.entry.id, sequence: 2 },
    status: "DEDUPLICATED",
  });
  await expect(
    chat.sendMessage({
      actorUserId: fixture.customerOwnerId,
      body: "Iný úmysel",
      commandId: customerCommandId,
      conversationId: fixture.conversationId,
    }),
  ).rejects.toBeInstanceOf(ConversationChatIdempotencyError);

  const craftsmanSent = await chat.sendMessage({
    actorUserId: fixture.craftsmanOwnerId,
    body: "Áno, navrhujem budúci týždeň.",
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
    replyToMessageId: customerSent.entry.id,
  });
  expect(craftsmanSent).toMatchObject({
    entry: {
      author: "SELF",
      replyToMessageId: customerSent.entry.id,
      sequence: 3,
    },
    status: "SENT",
  });
  if (!("entry" in craftsmanSent)) throw new Error("Expected reply message.");

  await expect(
    chat.readTimeline({
      actorUserId: fixture.customerOwnerId,
      conversationId: fixture.conversationId,
      limit: 2,
    }),
  ).resolves.toMatchObject({ hasMore: true, unreadCount: 1 });

  const read = await chat.updateParticipantState({
    action: "MARK_READ",
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
    expectedRevision: 0,
    readThroughSequence: craftsmanSent.entry.sequence,
  });
  expect(read).toMatchObject({
    participantState: {
      lastReadSequence: craftsmanSent.entry.sequence,
      revision: 1,
    },
    status: "APPLIED",
  });
  if (read.status !== "APPLIED") {
    throw new Error("Expected MARK_READ to be applied.");
  }
  if (!(read.participantState.lastReadAt instanceof Date)) {
    throw new Error(
      "MARK_READ must persist the database-authored read timestamp.",
    );
  }
  const muted = await chat.updateParticipantState({
    action: "MUTE",
    actorUserId: fixture.customerOwnerId,
    commandId: randomUUID(),
    conversationId: fixture.conversationId,
    expectedRevision: 1,
  });
  expect(muted).toMatchObject({
    participantState: { muted: true, revision: 2 },
    status: "APPLIED",
  });
  const archivedCommandId = randomUUID();
  await expect(
    chat.updateParticipantState({
      action: "ARCHIVE",
      actorUserId: fixture.customerOwnerId,
      commandId: archivedCommandId,
      conversationId: fixture.conversationId,
      expectedRevision: 2,
    }),
  ).resolves.toMatchObject({
    participantState: { archived: true, muted: true, revision: 3 },
    status: "APPLIED",
  });
  await expect(
    chat.updateParticipantState({
      action: "ARCHIVE",
      actorUserId: fixture.customerOwnerId,
      commandId: archivedCommandId,
      conversationId: fixture.conversationId,
      expectedRevision: 2,
    }),
  ).resolves.toMatchObject({ status: "DEDUPLICATED" });
  await expect(
    chat.updateParticipantState({
      action: "UNMUTE",
      actorUserId: fixture.customerOwnerId,
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
      expectedRevision: 1,
    }),
  ).resolves.toEqual({ currentRevision: 3, status: "STALE" });

  const reportCommandId = randomUUID();
  const report = await chat.report({
    actorUserId: fixture.customerOwnerId,
    commandId: reportCommandId,
    conversationId: fixture.conversationId,
    messageId: craftsmanSent.entry.id,
    reason: "ABUSE",
  });
  expect(report).toMatchObject({ status: "REPORTED" });
  if (!("reportId" in report)) throw new Error("Expected report identity.");
  await expect(
    chat.report({
      actorUserId: fixture.customerOwnerId,
      commandId: reportCommandId,
      conversationId: fixture.conversationId,
      messageId: craftsmanSent.entry.id,
      reason: "ABUSE",
    }),
  ).resolves.toMatchObject({
    reportId: report.reportId,
    status: "DEDUPLICATED",
  });

  const outsiderId = randomUUID() as UserId;
  await sql`INSERT INTO users (id) VALUES (${outsiderId})`;
  await expect(
    chat.readTimeline({
      actorUserId: outsiderId,
      conversationId: fixture.conversationId,
    }),
  ).resolves.toBeNull();
  await expect(
    chat.sendMessage({
      actorUserId: outsiderId,
      body: "Nemám sem prístup",
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await expect(
    chat.report({
      actorUserId: outsiderId,
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
      reason: "OTHER",
    }),
  ).resolves.toEqual({ status: "NOT_FOUND" });

  await expect(
    sql`
      INSERT INTO conversation_message_commands (
        command_id, conversation_id, actor_user_id, body,
        reply_to_message_id, resulting_message_id, payload_fingerprint,
        created_at
      ) VALUES (
        ${randomUUID()}, ${fixture.conversationId}, ${fixture.customerOwnerId},
        'kontakt@example.sk', NULL, ${randomUUID()}, ${"0".repeat(64)},
        clock_timestamp()
      )
    `,
  ).rejects.toThrow(/contact policy/u);
  await expect(
    sql`UPDATE conversation_timeline_entries SET body = 'prepísané'
      WHERE id = ${customerSent.entry.id}`,
  ).rejects.toThrow(/append-only/u);
  await expect(
    sql`DELETE FROM conversation_timeline_entries
      WHERE id = ${customerSent.entry.id}`,
  ).rejects.toThrow(/append-only/u);
}

export async function runConversationChatReadOnlyIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await loadFixture(sql, "READ_ONLY");
  const chat = createConversationChatRepository(sql);
  await expect(
    chat.sendMessage({
      actorUserId: fixture.customerOwnerId,
      body: "Toto sa už nesmie odoslať",
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
    }),
  ).resolves.toEqual({ status: "READ_ONLY" });
  const history = await chat.readTimeline({
    actorUserId: fixture.customerOwnerId,
    conversationId: fixture.conversationId,
  });
  expect(history?.entries.length).toBeGreaterThan(0);
  if (history === null) {
    throw new Error("Expected readable terminal conversation history.");
  }
  let archivedState = history.participantState;
  if (!archivedState.archived) {
    const archived = await chat.updateParticipantState({
      action: "ARCHIVE",
      actorUserId: fixture.customerOwnerId,
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
      expectedRevision: archivedState.revision,
    });
    if (
      archived.status !== "APPLIED" ||
      !("participantState" in archived) ||
      !archived.participantState.archived
    ) {
      throw new Error("Expected terminal conversation to be archivable.");
    }
    archivedState = archived.participantState;
  }
  await expect(
    chat.updateParticipantState({
      action: "UNARCHIVE",
      actorUserId: fixture.customerOwnerId,
      commandId: randomUUID(),
      conversationId: fixture.conversationId,
      expectedRevision: archivedState.revision,
    }),
  ).resolves.toMatchObject({
    participantState: {
      archived: false,
      revision: archivedState.revision + 1,
    },
    status: "APPLIED",
  });
}

async function loadFixture(sql: Sql, access: "READ_ONLY" | "WRITABLE") {
  const [fixture] = await sql<Fixture[]>`
    SELECT conversation.id AS "conversationId",
      customer.owner_user_id AS "customerOwnerId",
      craftsman.owner_user_id AS "craftsmanOwnerId"
    FROM current_conversations conversation
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = conversation.craftsman_profile_id
    WHERE conversation.access_state = ${access}
    ORDER BY conversation.created_at DESC, conversation.id DESC
    LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error(`R3-012 requires a ${access} conversation fixture.`);
  }
  return fixture;
}
