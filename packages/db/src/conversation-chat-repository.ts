import { createHash, randomUUID } from "node:crypto";

import {
  CONVERSATION_TIMELINE_MAX_PAGE_SIZE,
  CONVERSATION_MESSAGE_MAX_ATTACHMENTS,
  CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS,
  ConversationChatIdempotencyError,
  evaluateConversationMessagePolicy,
  assertConversationParticipantStateInput,
  assertConversationReportInput,
  assertConversationTimelineReadInput,
  normalizeConversationMessageSendInput,
  type ConversationChatPersistence,
  type ConversationId,
  type ConversationMessageId,
  type ConversationMessageSendInput,
  type ConversationMessageSendResult,
  type ConversationParticipantRole,
  type ConversationParticipantState,
  type ConversationParticipantStateInput,
  type ConversationParticipantStateResult,
  type ConversationReportInput,
  type ConversationReportResult,
  type ConversationTimelineEntry,
  type ConversationTimelineAttachment,
  type ConversationTimelinePage,
  type ConversationTimelineReadInput,
  type UserId,
} from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface ParticipantRow {
  readonly access: "READ_ONLY" | "WRITABLE";
  readonly counterpartUserId: string;
  readonly participantRole: ConversationParticipantRole;
}

interface EntryRow {
  readonly authorRole: ConversationParticipantRole | null;
  readonly authorUserId: string | null;
  readonly body: string | null;
  readonly conversationId: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly kind: "HUMAN_MESSAGE" | "SYSTEM_EVENT";
  readonly hiddenByModeration: boolean;
  readonly replyToMessageId: string | null;
  readonly sequence: number;
  readonly systemEvent: "ENGAGEMENT" | null;
}

interface AttachmentRow {
  readonly assetId: string;
  readonly createdAt: Date;
  readonly kind: "DOCUMENT" | "IMAGE";
  readonly messageId: string;
  readonly status: "PROCESSING" | "READY" | "REJECTED";
}

interface StateRow {
  readonly archived: boolean;
  readonly lastReadAt: Date | null;
  readonly lastReadSequence: number;
  readonly muted: boolean;
  readonly revision: number;
}

interface MessageCommandRow {
  readonly actorUserId: string;
  readonly conversationId: string;
  readonly payloadFingerprint: string;
  readonly resultingMessageId: string;
}

interface MessagePolicyRow {
  readonly stage: string | null;
}

interface StateCommandRow {
  readonly actorUserId: string;
  readonly conversationId: string;
  readonly payloadFingerprint: string;
  readonly resultingRevision: number;
}

interface ReportRow {
  readonly id: string;
  readonly payloadFingerprint: string;
  readonly reporterUserId: string;
  readonly conversationId: string;
}

export function createConversationChatRepository(
  sql: Sql,
): ConversationChatPersistence {
  return Object.freeze({
    readTimeline(input: ConversationTimelineReadInput) {
      assertConversationTimelineReadInput(input);
      return sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => readTimeline(transaction, input),
      );
    },
    report(input: ConversationReportInput) {
      assertConversationReportInput(input);
      return sql.begin(async (transaction) => report(transaction, input));
    },
    sendMessage(input: ConversationMessageSendInput) {
      const normalized = normalizeConversationMessageSendInput(input);
      return sql
        .begin(async (transaction) => sendMessage(transaction, normalized))
        .catch((error: unknown) => {
          if (isDatabasePolicyBlock(error)) {
            return Object.freeze({
              status: "BLOCKED_BY_CONTACT_POLICY" as const,
            });
          }
          throw error;
        });
    },
    updateParticipantState(input: ConversationParticipantStateInput) {
      assertConversationParticipantStateInput(input);
      return sql.begin(async (transaction) =>
        updateParticipantState(transaction, input),
      );
    },
  });
}

async function readTimeline(
  transaction: TransactionSql,
  input: ConversationTimelineReadInput,
): Promise<ConversationTimelinePage | null> {
  const participant = await findParticipant(
    transaction,
    input.conversationId,
    input.actorUserId,
    false,
  );
  if (participant === null) return null;
  const [ownState, counterpartState] = await Promise.all([
    loadCurrentState(transaction, input.conversationId, input.actorUserId),
    loadCurrentState(
      transaction,
      input.conversationId,
      participant.counterpartUserId,
    ),
  ]);
  const limit = input.limit ?? CONVERSATION_TIMELINE_MAX_PAGE_SIZE;
  const rows = await transaction<EntryRow[]>`
    SELECT entry.id, entry.conversation_id AS "conversationId",
      entry.sequence::integer AS sequence, entry.entry_kind AS kind,
      entry.author_user_id AS "authorUserId",
      CASE WHEN hidden.action_id IS NULL THEN entry.body ELSE NULL END AS body,
      (hidden.action_id IS NOT NULL) AS "hiddenByModeration",
      entry.reply_to_message_id AS "replyToMessageId",
      entry.system_event AS "systemEvent", entry.created_at AS "createdAt",
      CASE
        WHEN entry.author_user_id = customer.owner_user_id THEN 'CUSTOMER'
        WHEN entry.author_user_id = craftsman.owner_user_id THEN 'CRAFTSMAN'
        ELSE NULL
      END AS "authorRole"
    FROM conversation_timeline_entries entry
    JOIN current_conversations current ON current.id = entry.conversation_id
    JOIN customer_profiles customer
      ON customer.id = current.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = current.craftsman_profile_id
    LEFT JOIN current_moderation_hidden_targets hidden
      ON hidden.target_type = 'MESSAGE' AND hidden.target_id = entry.id
    WHERE entry.conversation_id = ${input.conversationId}
      AND (${input.beforeSequence ?? null}::bigint IS NULL
        OR entry.sequence < ${input.beforeSequence ?? null})
    ORDER BY entry.sequence DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit).reverse();
  const attachments = await loadAttachments(
    transaction,
    selected.filter((row) => row.kind === "HUMAN_MESSAGE").map((row) => row.id),
  );
  const entries = Object.freeze(
    selected.map((row) =>
      toTimelineEntry(
        row,
        input.actorUserId,
        counterpartState.lastReadSequence,
        row.hiddenByModeration
          ? Object.freeze([])
          : (attachments.get(row.id) ?? Object.freeze([])),
      ),
    ),
  );
  const [unread] = await transaction<Array<{ readonly count: number }>>`
    SELECT count(*)::integer AS count
    FROM conversation_timeline_entries entry
    WHERE entry.conversation_id = ${input.conversationId}
      AND entry.sequence > ${ownState.lastReadSequence}
      AND entry.entry_kind = 'HUMAN_MESSAGE'
      AND entry.author_user_id <> ${input.actorUserId}
  `;
  if (unread === undefined || !isNonnegativeInteger(unread.count)) {
    throw new Error("Corrupt conversation unread projection.");
  }
  return Object.freeze({
    entries,
    hasMore,
    nextBeforeSequence:
      hasMore && selected[0] !== undefined ? selected[0].sequence : null,
    participantState: ownState,
    unreadCount: unread.count,
  });
}

async function sendMessage(
  transaction: TransactionSql,
  input: ConversationMessageSendInput,
): Promise<ConversationMessageSendResult> {
  await commandLock(transaction, input.commandId, 45_001);
  await lockNotificationState(
    transaction,
    input.conversationId,
    input.actorUserId,
    "COUNTERPART",
  );
  const participant = await findParticipant(
    transaction,
    input.conversationId,
    input.actorUserId,
    true,
  );
  if (participant === null) return Object.freeze({ status: "NOT_FOUND" });
  const fingerprint = messageFingerprint(input);
  const [existing] = await transaction<MessageCommandRow[]>`
    SELECT conversation_id AS "conversationId", actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_message_id AS "resultingMessageId"
    FROM conversation_message_commands WHERE command_id = ${input.commandId}
  `;
  if (existing !== undefined) {
    assertReplay(
      existing,
      input.conversationId,
      input.actorUserId,
      fingerprint,
    );
    const entry = await loadEntry(
      transaction,
      existing.resultingMessageId,
      input.actorUserId,
      participant.counterpartUserId,
    );
    return Object.freeze({ entry, status: "DEDUPLICATED" });
  }
  if (participant.access !== "WRITABLE") {
    return Object.freeze({ status: "READ_ONLY" });
  }
  const [policy] = await transaction<MessagePolicyRow[]>`
    SELECT conversation_message_policy_stage(${input.conversationId}) AS stage
  `;
  if (
    policy === undefined ||
    (policy.stage !== "PRE_CONFIRM" && policy.stage !== "POST_CONFIRM")
  ) {
    throw new Error("Conversation message policy stage unavailable.");
  }
  if (
    evaluateConversationMessagePolicy({
      body: input.body,
      stage: policy.stage,
    }).status === "BLOCK"
  ) {
    return Object.freeze({ status: "BLOCKED_BY_CONTACT_POLICY" });
  }
  const [command] = await transaction<
    Array<{ readonly resultingMessageId: string }>
  >`
    INSERT INTO conversation_message_commands (
      command_id, conversation_id, actor_user_id, body,
      reply_to_message_id, resulting_message_id, payload_fingerprint, created_at
    ) VALUES (
      ${input.commandId}, ${input.conversationId}, ${input.actorUserId},
      ${input.body}, ${input.replyToMessageId ?? null}, ${randomUUID()},
      ${fingerprint}, clock_timestamp()
    ) RETURNING resulting_message_id AS "resultingMessageId"
  `;
  if (command === undefined) throw new Error("Message command was not stored.");
  await transaction`
    INSERT INTO conversation_timeline_entries (
      id, conversation_id, sequence, entry_kind, author_user_id, body,
      reply_to_message_id, message_command_id, system_event,
      source_invitation_id, source_invitation_revision, created_at
    ) VALUES (
      ${command.resultingMessageId}, ${input.conversationId}, 1,
      'HUMAN_MESSAGE', ${input.actorUserId}, ${input.body},
      ${input.replyToMessageId ?? null}, ${input.commandId}, NULL, NULL, NULL,
      clock_timestamp()
    )
  `;
  const entry = await loadEntry(
    transaction,
    command.resultingMessageId,
    input.actorUserId,
    participant.counterpartUserId,
  );
  return Object.freeze({ entry, status: "SENT" });
}

function isDatabasePolicyBlock(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("message blocked by pre-confirmation contact policy")
  );
}

async function updateParticipantState(
  transaction: TransactionSql,
  input: ConversationParticipantStateInput,
): Promise<ConversationParticipantStateResult> {
  await commandLock(transaction, input.commandId, 45_002);
  await lockNotificationState(
    transaction,
    input.conversationId,
    input.actorUserId,
    "SELF",
  );
  const participant = await findParticipant(
    transaction,
    input.conversationId,
    input.actorUserId,
    true,
  );
  if (participant === null) return Object.freeze({ status: "NOT_FOUND" });
  const fingerprint = stateFingerprint(input);
  const [existing] = await transaction<StateCommandRow[]>`
    SELECT conversation_id AS "conversationId", actor_user_id AS "actorUserId",
      payload_fingerprint AS "payloadFingerprint",
      resulting_revision AS "resultingRevision"
    FROM conversation_participant_state_commands
    WHERE command_id = ${input.commandId}
  `;
  if (existing !== undefined) {
    assertReplay(
      existing,
      input.conversationId,
      input.actorUserId,
      fingerprint,
    );
    const participantState = await loadStateRevision(
      transaction,
      input.conversationId,
      input.actorUserId,
      existing.resultingRevision,
    );
    return Object.freeze({ participantState, status: "DEDUPLICATED" });
  }
  const current = await loadCurrentState(
    transaction,
    input.conversationId,
    input.actorUserId,
  );
  if (current.revision !== input.expectedRevision) {
    return Object.freeze({
      currentRevision: current.revision,
      status: "STALE",
    });
  }
  const [command] = await transaction<
    Array<{ readonly resultingRevision: number }>
  >`
    INSERT INTO conversation_participant_state_commands (
      command_id, conversation_id, actor_user_id, action, expected_revision,
      resulting_revision, read_through_sequence, payload_fingerprint, created_at
    ) VALUES (
      ${input.commandId}, ${input.conversationId}, ${input.actorUserId},
      ${input.action}, ${input.expectedRevision}, ${input.expectedRevision + 1},
      ${input.readThroughSequence ?? null}, ${fingerprint}, clock_timestamp()
    ) RETURNING resulting_revision AS "resultingRevision"
  `;
  if (command === undefined) throw new Error("State command was not stored.");
  const [revision] = await transaction<StateRow[]>`
    INSERT INTO conversation_participant_state_revisions (
      conversation_id, actor_user_id, revision, command_id,
      last_read_sequence, last_read_at, archived, muted, changed_at
    ) VALUES (
      ${input.conversationId}, ${input.actorUserId},
      ${command.resultingRevision}, ${input.commandId}, 0, NULL, false, false,
      clock_timestamp()
    ) RETURNING revision, last_read_sequence::integer AS "lastReadSequence",
      last_read_at AS "lastReadAt",
      archived, muted
  `;
  if (revision === undefined) throw new Error("State revision was not stored.");
  return Object.freeze({
    participantState: toParticipantState(revision),
    status: "APPLIED",
  });
}

async function lockNotificationState(
  transaction: TransactionSql,
  conversationId: ConversationId,
  actorUserId: UserId,
  recipient: "COUNTERPART" | "SELF",
): Promise<void> {
  await transaction`
    SELECT state.recipient_user_id
    FROM conversations conversation
    JOIN job_invitations invitation
      ON invitation.id = conversation.invitation_id
    JOIN customer_profiles customer
      ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = invitation.craftsman_profile_id
    JOIN conversation_notification_states state
      ON state.conversation_id = conversation.id
     AND state.recipient_user_id = CASE
       WHEN ${recipient} = 'SELF' THEN ${actorUserId}::uuid
       WHEN customer.owner_user_id = ${actorUserId}
         THEN craftsman.owner_user_id
       ELSE customer.owner_user_id
     END
    WHERE conversation.id = ${conversationId}
      AND (${actorUserId} = customer.owner_user_id
        OR ${actorUserId} = craftsman.owner_user_id)
    FOR UPDATE OF state
  `;
}

async function report(
  transaction: TransactionSql,
  input: ConversationReportInput,
): Promise<ConversationReportResult> {
  await commandLock(transaction, input.commandId, 45_003);
  if (
    (await findParticipant(
      transaction,
      input.conversationId,
      input.actorUserId,
      true,
    )) === null
  ) {
    return Object.freeze({ status: "NOT_FOUND" });
  }
  const fingerprint = reportFingerprint(input);
  const [existing] = await transaction<ReportRow[]>`
    SELECT id, conversation_id AS "conversationId",
      reporter_user_id AS "reporterUserId",
      payload_fingerprint AS "payloadFingerprint"
    FROM conversation_reports WHERE command_id = ${input.commandId}
  `;
  if (existing !== undefined) {
    assertReplay(
      {
        actorUserId: existing.reporterUserId,
        conversationId: existing.conversationId,
        payloadFingerprint: existing.payloadFingerprint,
      },
      input.conversationId,
      input.actorUserId,
      fingerprint,
    );
    return Object.freeze({ reportId: existing.id, status: "DEDUPLICATED" });
  }
  const [created] = await transaction<Array<{ readonly id: string }>>`
    INSERT INTO conversation_reports (
      id, command_id, conversation_id, reporter_user_id, message_id, reason,
      payload_fingerprint, created_at
    ) VALUES (
      ${randomUUID()}, ${input.commandId}, ${input.conversationId},
      ${input.actorUserId}, ${input.messageId ?? null}, ${input.reason},
      ${fingerprint}, clock_timestamp()
    ) RETURNING id
  `;
  if (created === undefined || !isUuid(created.id)) {
    throw new Error("Conversation report was not stored.");
  }
  return Object.freeze({ reportId: created.id, status: "REPORTED" });
}

async function findParticipant(
  transaction: TransactionSql,
  conversationId: ConversationId,
  actorUserId: string,
  lock: boolean,
): Promise<ParticipantRow | null> {
  if (lock) {
    const actors = await transaction`
      SELECT id FROM users
      WHERE id = ${actorUserId} AND account_state = 'ACTIVE'
      FOR UPDATE
    `;
    if (actors.length !== 1) return null;
    const invitations = await transaction`
      SELECT invitation.id
      FROM conversations conversation
      JOIN job_invitations invitation
        ON invitation.id = conversation.invitation_id
      WHERE conversation.id = ${conversationId}
      FOR UPDATE OF invitation
    `;
    if (invitations.length !== 1) return null;
  }
  const rows = lock
    ? await transaction<ParticipantRow[]>`
        SELECT current.access_state AS access,
          CASE WHEN customer.owner_user_id = actor.id
            THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END AS "participantRole",
          CASE WHEN customer.owner_user_id = actor.id
            THEN craftsman.owner_user_id ELSE customer.owner_user_id END
            AS "counterpartUserId"
        FROM conversations conversation
        JOIN current_conversations current ON current.id = conversation.id
        JOIN customer_profiles customer
          ON customer.id = current.customer_profile_id
        JOIN craftsman_profiles craftsman
          ON craftsman.id = current.craftsman_profile_id
        JOIN users actor ON actor.id = ${actorUserId}
          AND actor.account_state = 'ACTIVE'
        WHERE conversation.id = ${conversationId}
          AND (customer.owner_user_id = actor.id
            OR craftsman.owner_user_id = actor.id)
        FOR UPDATE OF conversation
      `
    : await transaction<ParticipantRow[]>`
        SELECT current.access_state AS access,
          CASE WHEN customer.owner_user_id = actor.id
            THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END AS "participantRole",
          CASE WHEN customer.owner_user_id = actor.id
            THEN craftsman.owner_user_id ELSE customer.owner_user_id END
            AS "counterpartUserId"
        FROM current_conversations current
        JOIN customer_profiles customer
          ON customer.id = current.customer_profile_id
        JOIN craftsman_profiles craftsman
          ON craftsman.id = current.craftsman_profile_id
        JOIN users actor ON actor.id = ${actorUserId}
          AND actor.account_state = 'ACTIVE'
        WHERE current.id = ${conversationId}
          AND (customer.owner_user_id = actor.id
            OR craftsman.owner_user_id = actor.id)
      `;
  const row = rows[0];
  if (row === undefined) return null;
  if (
    (row.access !== "READ_ONLY" && row.access !== "WRITABLE") ||
    (row.participantRole !== "CUSTOMER" &&
      row.participantRole !== "CRAFTSMAN") ||
    !isUuid(row.counterpartUserId)
  ) {
    throw new Error("Corrupt conversation participant projection.");
  }
  return row;
}

async function loadCurrentState(
  transaction: TransactionSql,
  conversationId: ConversationId,
  actorUserId: string,
): Promise<ConversationParticipantState> {
  const [row] = await transaction<StateRow[]>`
    SELECT revision, last_read_sequence::integer AS "lastReadSequence",
      last_read_at AS "lastReadAt",
      archived, muted
    FROM current_conversation_participant_states
    WHERE conversation_id = ${conversationId} AND actor_user_id = ${actorUserId}
  `;
  return row === undefined
    ? Object.freeze({
        archived: false,
        lastReadAt: null,
        lastReadSequence: 0,
        muted: false,
        revision: 0,
      })
    : toParticipantState(row);
}

async function loadStateRevision(
  transaction: TransactionSql,
  conversationId: ConversationId,
  actorUserId: string,
  revision: number,
): Promise<ConversationParticipantState> {
  const [row] = await transaction<StateRow[]>`
    SELECT revision, last_read_sequence::integer AS "lastReadSequence",
      last_read_at AS "lastReadAt",
      archived, muted
    FROM conversation_participant_state_revisions
    WHERE conversation_id = ${conversationId} AND actor_user_id = ${actorUserId}
      AND revision = ${revision}
  `;
  if (row === undefined)
    throw new Error("Conversation state effect is missing.");
  return toParticipantState(row);
}

async function loadEntry(
  transaction: TransactionSql,
  messageId: string,
  actorUserId: string,
  counterpartUserId: string,
): Promise<ConversationTimelineEntry> {
  const [row] = await transaction<EntryRow[]>`
    SELECT entry.id, entry.conversation_id AS "conversationId",
      entry.sequence::integer AS sequence, entry.entry_kind AS kind,
      entry.author_user_id AS "authorUserId",
      CASE WHEN hidden.action_id IS NULL THEN entry.body ELSE NULL END AS body,
      (hidden.action_id IS NOT NULL) AS "hiddenByModeration",
      entry.reply_to_message_id AS "replyToMessageId",
      entry.system_event AS "systemEvent", entry.created_at AS "createdAt",
      CASE
        WHEN entry.author_user_id = customer.owner_user_id THEN 'CUSTOMER'
        WHEN entry.author_user_id = craftsman.owner_user_id THEN 'CRAFTSMAN'
        ELSE NULL
      END AS "authorRole"
    FROM conversation_timeline_entries entry
    JOIN current_conversations current ON current.id = entry.conversation_id
    JOIN customer_profiles customer
      ON customer.id = current.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = current.craftsman_profile_id
    LEFT JOIN current_moderation_hidden_targets hidden
      ON hidden.target_type = 'MESSAGE' AND hidden.target_id = entry.id
    WHERE entry.id = ${messageId}
  `;
  if (row === undefined)
    throw new Error("Conversation message effect is missing.");
  const counterpartState = await loadCurrentState(
    transaction,
    row.conversationId as ConversationId,
    counterpartUserId,
  );
  const attachments = await loadAttachments(transaction, [row.id]);
  return toTimelineEntry(
    row,
    actorUserId,
    counterpartState.lastReadSequence,
    attachments.get(row.id) ?? Object.freeze([]),
  );
}

async function loadAttachments(
  transaction: TransactionSql,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ConversationTimelineAttachment[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await transaction<AttachmentRow[]>`
    SELECT asset.id AS "assetId", asset.provenance_entity_id AS "messageId",
      asset.kind, asset.status, asset.created_at AS "createdAt"
    FROM media_assets asset
    WHERE asset.provenance_entity_type = 'CONVERSATION_MESSAGE'
      AND asset.provenance_entity_id = ANY(${messageIds}::uuid[])
      AND asset.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
    ORDER BY asset.provenance_entity_id, asset.created_at, asset.id
    LIMIT ${messageIds.length * CONVERSATION_MESSAGE_MAX_ATTACHMENTS + 1}
  `;
  if (rows.length > messageIds.length * CONVERSATION_MESSAGE_MAX_ATTACHMENTS) {
    throw new Error("Corrupt conversation attachment projection.");
  }
  const grouped = new Map<string, ConversationTimelineAttachment[]>();
  for (const row of rows) {
    if (
      !isUuid(row.assetId) ||
      !messageIds.includes(row.messageId) ||
      (row.kind !== "IMAGE" && row.kind !== "DOCUMENT") ||
      !["PROCESSING", "READY", "REJECTED"].includes(row.status) ||
      !(row.createdAt instanceof Date) ||
      Number.isNaN(row.createdAt.valueOf())
    ) {
      throw new Error("Corrupt conversation attachment projection.");
    }
    const current = grouped.get(row.messageId) ?? [];
    current.push(
      Object.freeze({
        assetId: row.assetId,
        createdAt: new Date(row.createdAt),
        kind: row.kind === "IMAGE" ? "IMAGE" : "PDF",
        status: row.status,
      }),
    );
    if (
      current.length > CONVERSATION_MESSAGE_MAX_ATTACHMENTS ||
      current.filter((attachment) => attachment.kind === "IMAGE").length >
        CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS
    ) {
      throw new Error("Corrupt conversation attachment projection.");
    }
    grouped.set(row.messageId, current);
  }
  return new Map(
    [...grouped].map(([messageId, items]) => [messageId, Object.freeze(items)]),
  );
}

function toTimelineEntry(
  row: EntryRow,
  actorUserId: string,
  counterpartLastRead: number,
  attachments: readonly ConversationTimelineAttachment[],
): ConversationTimelineEntry {
  if (
    !isUuid(row.id) ||
    !isUuid(row.conversationId) ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !(row.createdAt instanceof Date) ||
    Number.isNaN(row.createdAt.valueOf()) ||
    (row.replyToMessageId !== null && !isUuid(row.replyToMessageId)) ||
    (row.kind !== "HUMAN_MESSAGE" && row.kind !== "SYSTEM_EVENT")
  ) {
    throw new Error("Corrupt conversation timeline entry.");
  }
  if (row.kind === "SYSTEM_EVENT") {
    if (
      row.authorUserId !== null ||
      row.authorRole !== null ||
      row.body !== null ||
      row.systemEvent !== "ENGAGEMENT"
    ) {
      throw new Error("Corrupt conversation system event.");
    }
    return Object.freeze({
      attachments: Object.freeze([]),
      author: "SYSTEM",
      authorRole: null,
      body: null,
      conversationId: row.conversationId as ConversationId,
      createdAt: new Date(row.createdAt),
      id: row.id as ConversationMessageId,
      kind: row.kind,
      hiddenByModeration: false,
      readByCounterpart: null,
      replyToMessageId: null,
      sequence: row.sequence,
      systemEvent: row.systemEvent,
    });
  }
  if (
    !isUuid(row.authorUserId) ||
    (row.authorRole !== "CUSTOMER" && row.authorRole !== "CRAFTSMAN") ||
    (row.hiddenByModeration
      ? row.body !== null
      : typeof row.body !== "string" ||
        row.body.length < 1 ||
        row.body.length > 4_000) ||
    row.systemEvent !== null
  ) {
    throw new Error("Corrupt conversation human message.");
  }
  const self = row.authorUserId === actorUserId;
  return Object.freeze({
    attachments,
    author: self ? "SELF" : "COUNTERPART",
    authorRole: row.authorRole,
    body: row.body,
    conversationId: row.conversationId as ConversationId,
    createdAt: new Date(row.createdAt),
    id: row.id as ConversationMessageId,
    kind: row.kind,
    hiddenByModeration: row.hiddenByModeration,
    readByCounterpart: self ? counterpartLastRead >= row.sequence : null,
    replyToMessageId: row.replyToMessageId as ConversationMessageId | null,
    sequence: row.sequence,
    systemEvent: null,
  });
}

function toParticipantState(row: StateRow): ConversationParticipantState {
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    !isNonnegativeInteger(row.lastReadSequence) ||
    (row.lastReadAt !== null &&
      (!(row.lastReadAt instanceof Date) ||
        Number.isNaN(row.lastReadAt.valueOf()))) ||
    typeof row.archived !== "boolean" ||
    typeof row.muted !== "boolean"
  ) {
    throw new Error("Corrupt conversation participant state.");
  }
  return Object.freeze({
    archived: row.archived,
    lastReadAt: row.lastReadAt === null ? null : new Date(row.lastReadAt),
    lastReadSequence: row.lastReadSequence,
    muted: row.muted,
    revision: row.revision,
  });
}

function assertReplay(
  existing: {
    readonly actorUserId: string;
    readonly conversationId: string;
    readonly payloadFingerprint: string;
  },
  conversationId: string,
  actorUserId: string,
  fingerprint: string,
): void {
  if (
    existing.conversationId !== conversationId ||
    existing.actorUserId !== actorUserId ||
    existing.payloadFingerprint !== fingerprint
  ) {
    throw new ConversationChatIdempotencyError(
      "Conversation command id was reused with another intent.",
    );
  }
}

async function commandLock(
  transaction: TransactionSql,
  commandId: string,
  namespace: number,
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, ${namespace}))
  `;
}

function messageFingerprint(input: ConversationMessageSendInput): string {
  return hash(
    JSON.stringify({
      actorUserId: input.actorUserId,
      body: input.body,
      conversationId: input.conversationId,
      replyToMessageId: input.replyToMessageId ?? null,
    }),
  );
}

function stateFingerprint(input: ConversationParticipantStateInput): string {
  return hash(
    JSON.stringify({
      action: input.action,
      actorUserId: input.actorUserId,
      conversationId: input.conversationId,
      expectedRevision: input.expectedRevision,
      readThroughSequence: input.readThroughSequence ?? null,
    }),
  );
}

function reportFingerprint(input: ConversationReportInput): string {
  return hash(
    JSON.stringify({
      actorUserId: input.actorUserId,
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      reason: input.reason,
    }),
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
