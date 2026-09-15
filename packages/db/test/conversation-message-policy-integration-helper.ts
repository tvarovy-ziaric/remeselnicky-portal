import { randomUUID } from "node:crypto";

import type { ConversationId, UserId } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

import { createConversationChatRepository } from "../src/conversation-chat-repository.js";

interface Fixture {
  readonly actorUserId: UserId;
  readonly conversationId: ConversationId;
}

export async function runConversationMessagePolicyIntegrationAssertions(
  sql: Sql,
): Promise<void> {
  const fixture = await loadFixture(sql);
  const chat = createConversationChatRepository(sql);

  for (const body of [
    "Napíšte mi na meno@example.sk",
    "Napíšte mi na ｍｅｎｏ＠ｅｘａｍｐｌｅ．ｓｋ",
    "Volajte +421 900 123 456",
    "Skúste mailto:meno@example.sk",
    "Som na Instagrame @majster_test",
    "Adresa: Hlavná 12",
    "Súradnice 48.1486, 17.1077",
  ]) {
    const commandId = randomUUID();
    await expect(
      chat.sendMessage({
        actorUserId: fixture.actorUserId,
        body,
        commandId,
        conversationId: fixture.conversationId,
      }),
    ).resolves.toEqual({ status: "BLOCKED_BY_CONTACT_POLICY" });
    const [retained] = await sql<{ readonly count: number }[]>`
      SELECT count(*)::integer AS count FROM conversation_message_commands
      WHERE command_id = ${commandId}
    `;
    expect(retained?.count).toBe(0);
  }

  for (const body of [
    "Napätie je 230/400 V.",
    "Potrubie má závit 1/2 palca.",
    "Rozmer je 120 × 80 cm.",
    "Prídem 15. 9. 2026 o 08:30.",
    "Číslo zákazky je 123456.",
    "Technický list je https://example.org/material.pdf",
    "Pomoc je https://facebook.com/business/help/article",
    "Dokument je https://instagram.com.evil.example/material.pdf",
  ]) {
    const commandId = randomUUID();
    const result = await chat.sendMessage({
      actorUserId: fixture.actorUserId,
      body,
      commandId,
      conversationId: fixture.conversationId,
    });
    expect(result).toMatchObject({ status: "SENT" });
    const [policy] = await sql<
      Array<{ readonly policyStage: string; readonly policyVersion: number }>
    >`
      SELECT policy_stage AS "policyStage", policy_version AS "policyVersion"
      FROM conversation_message_commands WHERE command_id = ${commandId}
    `;
    expect(policy).toEqual({ policyStage: "PRE_CONFIRM", policyVersion: 1 });
    await expect(
      chat.sendMessage({
        actorUserId: fixture.actorUserId,
        body,
        commandId,
        conversationId: fixture.conversationId,
      }),
    ).resolves.toMatchObject({ status: "DEDUPLICATED" });
  }

  await expect(
    insertRawMessage(sql, fixture, "https://wa.me/421900123456"),
  ).rejects.toThrow(/pre-confirmation contact policy/u);
  await expect(
    insertRawMessage(sql, fixture, "ｍｅｎｏ＠ｅｘａｍｐｌｅ．ｓｋ"),
  ).rejects.toThrow(/pre-confirmation contact policy/u);

  const spoofed = await insertRawMessage(
    sql,
    fixture,
    "Bežná správa cez raw SQL",
  );
  expect(spoofed).toMatchObject({
    policyStage: "PRE_CONFIRM",
    policyVersion: 1,
  });
  await expect(sql`
    UPDATE conversation_message_commands SET policy_stage = 'POST_CONFIRM'
    WHERE command_id = ${spoofed.commandId}
  `).rejects.toThrow(/append-only/u);

  await expect(
    sql.begin(async (transaction) => {
      await transaction`
        CREATE OR REPLACE FUNCTION conversation_message_policy_stage(
          target_conversation_id uuid
        )
        RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$
      `;
      await insertRawMessageInTransaction(transaction, fixture, "Bežná správa");
    }),
  ).rejects.toThrow(/policy stage unavailable/u);
}

async function insertRawMessage(sql: Sql, fixture: Fixture, body: string) {
  const commandId = randomUUID();
  return sql.begin((transaction) =>
    insertRawMessageInTransaction(transaction, fixture, body, commandId),
  );
}

async function insertRawMessageInTransaction(
  transaction: TransactionSql,
  fixture: Fixture,
  body: string,
  commandId = randomUUID(),
) {
  const [command] = await transaction<
    Array<{
      readonly commandId: string;
      readonly policyStage: string;
      readonly policyVersion: number;
      readonly resultingMessageId: string;
    }>
  >`
      INSERT INTO conversation_message_commands (
        command_id, conversation_id, actor_user_id, body,
        reply_to_message_id, resulting_message_id, payload_fingerprint,
        created_at, policy_stage, policy_version
      ) VALUES (
        ${commandId}, ${fixture.conversationId}, ${fixture.actorUserId},
        ${body}, NULL, ${randomUUID()}, ${"0".repeat(64)}, clock_timestamp(),
        'POST_CONFIRM', 999
      ) RETURNING command_id AS "commandId",
        resulting_message_id AS "resultingMessageId",
        policy_stage AS "policyStage", policy_version AS "policyVersion"
    `;
  if (command === undefined) throw new Error("Raw policy command missing.");
  await transaction`
      INSERT INTO conversation_timeline_entries (
        id, conversation_id, sequence, entry_kind, author_user_id, body,
        reply_to_message_id, message_command_id, system_event,
        source_invitation_id, source_invitation_revision, created_at
      ) VALUES (
        ${randomUUID()}, ${fixture.conversationId}, 1, 'HUMAN_MESSAGE',
        ${fixture.actorUserId}, 'client-spoofed body', NULL, ${commandId},
        NULL, NULL, NULL, clock_timestamp()
      )
    `;
  return command;
}

async function loadFixture(sql: Sql): Promise<Fixture> {
  const [fixture] = await sql<Fixture[]>`
    SELECT conversation.id AS "conversationId",
      customer.owner_user_id AS "actorUserId"
    FROM current_conversations conversation
    JOIN customer_profiles customer
      ON customer.id = conversation.customer_profile_id
    JOIN users actor ON actor.id = customer.owner_user_id
      AND actor.account_state = 'ACTIVE'
    WHERE conversation.access_state = 'WRITABLE'
    ORDER BY conversation.created_at DESC, conversation.id DESC
    LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error("R3-014 requires one writable conversation fixture.");
  }
  return fixture;
}
