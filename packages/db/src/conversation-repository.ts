import {
  CONVERSATION_ACCESS_STATES,
  assertConversationReadInput,
  assertInvitationConversationReadInput,
  type Conversation,
  type ConversationAccessState,
  type ConversationId,
  type ConversationPersistence,
  type CraftsmanProfileId,
  type CustomerProfileId,
  type InvitationConversationReadInput,
  type JobInvitationId,
  type JobRequestId,
  type ConversationReadInput,
} from "@portal/domain";
import type { Sql } from "postgres";

interface ConversationRow {
  readonly access: string;
  readonly counterpartDisplayName: string | null;
  readonly craftsmanProfileId: string;
  readonly createdAt: Date;
  readonly customerProfileId: string;
  readonly id: string;
  readonly invitationId: string;
  readonly jobRequestId: string;
  readonly participantRole: string;
  readonly requestTitle: string | null;
}

export function createConversationRepository(
  sql: Sql,
): ConversationPersistence {
  return Object.freeze({
    readOwned(input: ConversationReadInput) {
      assertConversationReadInput(input);
      return readOwned(sql, {
        actorUserId: input.actorUserId,
        conversationId: input.conversationId,
        invitationId: null,
      });
    },
    readOwnedByInvitation(input: InvitationConversationReadInput) {
      assertInvitationConversationReadInput(input);
      return readOwned(sql, {
        actorUserId: input.actorUserId,
        conversationId: null,
        invitationId: input.invitationId,
      });
    },
  });
}

async function readOwned(
  sql: Sql,
  input: ReadSelector,
): Promise<Conversation | null> {
  const [row] = await sql<ConversationRow[]>`
    SELECT current.id,
      current.invitation_id AS "invitationId",
      current.job_request_id AS "jobRequestId",
      current.customer_profile_id AS "customerProfileId",
      current.craftsman_profile_id AS "craftsmanProfileId",
      current.created_at AS "createdAt",
      current.access_state AS access,
      CASE WHEN customer.owner_user_id = actor.id
        THEN 'CUSTOMER' ELSE 'CRAFTSMAN' END AS "participantRole",
      'Konverzácia k zákazke' AS "requestTitle",
      CASE WHEN customer.owner_user_id = actor.id THEN
        COALESCE(
          CASE WHEN craftsman.profile_type = 'COMPANY'
            THEN craftsman.official_company_name
            ELSE COALESCE(craftsman.nickname,
              NULLIF(concat_ws(' ', craftsman.real_first_name,
                craftsman.real_last_name), ''))
          END,
          'Remeselník'
        )
      ELSE 'Zákazník ' || left(customer.id::text, 8) END
        AS "counterpartDisplayName"
    FROM current_conversations current
    JOIN conversations identity ON identity.id = current.id
    JOIN customer_profiles customer
      ON customer.id = current.customer_profile_id
    JOIN craftsman_profiles craftsman
      ON craftsman.id = current.craftsman_profile_id
    JOIN users actor ON actor.id = ${input.actorUserId}
      AND actor.account_state = 'ACTIVE'
    WHERE (${input.conversationId}::uuid IS NULL
        OR current.id = ${input.conversationId})
      AND (${input.invitationId}::uuid IS NULL
        OR current.invitation_id = ${input.invitationId})
      AND (customer.owner_user_id = actor.id
        OR craftsman.owner_user_id = actor.id)
  `;
  return row === undefined ? null : toConversation(row);
}

interface ReadSelector {
  readonly actorUserId: string;
  readonly conversationId: ConversationId | null;
  readonly invitationId: JobInvitationId | null;
}

function toConversation(row: ConversationRow): Conversation {
  if (
    !isUuid(row.id) ||
    !isUuid(row.invitationId) ||
    !isUuid(row.jobRequestId) ||
    !isUuid(row.customerProfileId) ||
    !isUuid(row.craftsmanProfileId) ||
    !(row.createdAt instanceof Date) ||
    Number.isNaN(row.createdAt.valueOf()) ||
    !CONVERSATION_ACCESS_STATES.some((state) => state === row.access) ||
    (row.participantRole !== "CUSTOMER" &&
      row.participantRole !== "CRAFTSMAN") ||
    row.counterpartDisplayName === null ||
    row.counterpartDisplayName.length < 1 ||
    row.counterpartDisplayName.length > 200 ||
    row.requestTitle === null ||
    row.requestTitle.length < 1 ||
    row.requestTitle.length > 160
  ) {
    throw new Error("Corrupt conversation projection.");
  }
  return Object.freeze({
    access: row.access as ConversationAccessState,
    counterpartDisplayName: row.counterpartDisplayName,
    craftsmanProfileId: row.craftsmanProfileId as CraftsmanProfileId,
    createdAt: new Date(row.createdAt),
    customerProfileId: row.customerProfileId as CustomerProfileId,
    id: row.id as ConversationId,
    invitationId: row.invitationId as JobInvitationId,
    jobRequestId: row.jobRequestId as JobRequestId,
    participantRole: row.participantRole,
    requestTitle: row.requestTitle,
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
