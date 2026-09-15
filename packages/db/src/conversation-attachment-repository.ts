import {
  CONVERSATION_MESSAGE_MAX_ATTACHMENTS,
  CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS,
} from "@portal/domain";
import {
  createServerMediaEntityAccess,
  createServerMediaProvenance,
  type ConversationAttachmentUploadAuthorization,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
} from "@portal/media";
import type { Sql } from "postgres";

interface PreparedMessageRow {
  readonly sequence: number;
}

interface AttachmentCountRow {
  readonly imageCount: number;
  readonly totalCount: number;
}

interface DeliveryRelationRow {
  readonly accessState: string;
  readonly actorStateChangedAt: Date;
  readonly conversationId: string;
  readonly invitationChangedAt: Date;
  readonly invitationRevision: number;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type PrepareUploadInput = Parameters<
  ConversationAttachmentUploadAuthorization["prepareUpload"]
>[0];

export function createConversationAttachmentUploadAuthorization(
  sql: Sql,
): ConversationAttachmentUploadAuthorization {
  return Object.freeze({
    async prepareUpload(input: PrepareUploadInput) {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.conversationId) ||
        !uuidPattern.test(input.messageId) ||
        (input.mediaKind !== "IMAGE" && input.mediaKind !== "PDF")
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      return sql.begin(async (transaction) => {
        const actors = await transaction`
          SELECT id FROM users
          WHERE id = ${input.actorUserId} AND account_state = 'ACTIVE'
          FOR UPDATE
        `;
        if (actors.length !== 1) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        const [identity] = await transaction<
          Array<{ readonly invitationId: string }>
        >`
          SELECT conversation.invitation_id AS "invitationId"
          FROM conversations conversation
          JOIN conversation_timeline_entries message
            ON message.conversation_id = conversation.id
          WHERE conversation.id = ${input.conversationId}
            AND message.id = ${input.messageId}
        `;
        if (
          identity === undefined ||
          !uuidPattern.test(identity.invitationId)
        ) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        const invitations = await transaction`
          SELECT id FROM job_invitations
          WHERE id = ${identity.invitationId}
          FOR UPDATE
        `;
        if (invitations.length !== 1) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        const [row] = await transaction<PreparedMessageRow[]>`
          SELECT message.sequence::integer AS sequence
          FROM conversations conversation
          JOIN current_conversations current ON current.id = conversation.id
          JOIN customer_profiles customer
            ON customer.id = current.customer_profile_id
          JOIN craftsman_profiles craftsman
            ON craftsman.id = current.craftsman_profile_id
          JOIN users actor ON actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
          JOIN conversation_timeline_entries message
            ON message.id = ${input.messageId}
            AND message.conversation_id = current.id
            AND message.entry_kind = 'HUMAN_MESSAGE'
            AND message.author_user_id = actor.id
          WHERE conversation.id = ${input.conversationId}
            AND current.access_state = 'WRITABLE'
            AND (customer.owner_user_id = actor.id
              OR craftsman.owner_user_id = actor.id)
          FOR UPDATE OF conversation, message
        `;
        if (row === undefined) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        const [counts] = await transaction<AttachmentCountRow[]>`
          SELECT count(*)::integer AS "totalCount",
            count(*) FILTER (WHERE asset.kind = 'IMAGE')::integer
              AS "imageCount"
          FROM media_assets asset
          WHERE asset.provenance_entity_type = 'CONVERSATION_MESSAGE'
            AND asset.provenance_entity_id = ${input.messageId}
            AND asset.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
        `;
        if (
          counts === undefined ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence < 1 ||
          !Number.isSafeInteger(counts.totalCount) ||
          !Number.isSafeInteger(counts.imageCount) ||
          counts.totalCount >= CONVERSATION_MESSAGE_MAX_ATTACHMENTS ||
          (input.mediaKind === "IMAGE" &&
            counts.imageCount >= CONVERSATION_MESSAGE_MAX_IMAGE_ATTACHMENTS)
        ) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        return Object.freeze({
          provenance: createServerMediaProvenance({
            entityId: input.messageId,
            entityRevision: row.sequence,
            entityType: "CONVERSATION_MESSAGE",
          }),
          purpose:
            input.mediaKind === "IMAGE"
              ? ("CHAT_IMAGE" as const)
              : ("CHAT_DOCUMENT" as const),
          status: "AUTHORIZED" as const,
        });
      });
    },
  });
}

/**
 * Re-resolves the exact current conversation relation on every private-media
 * authorization pass. Terminal READ_ONLY conversations remain historical.
 */
export function createConversationAttachmentMediaAccessResolver(
  sql: Sql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      if (
        snapshot.asset.provenanceEntityType !== "CONVERSATION_MESSAGE" ||
        snapshot.asset.provenanceEntityId === null ||
        snapshot.asset.provenanceEntityRevision === null ||
        (snapshot.asset.purpose !== "CHAT_IMAGE" &&
          snapshot.asset.purpose !== "CHAT_DOCUMENT") ||
        !uuidPattern.test(snapshot.actor.userId) ||
        !uuidPattern.test(snapshot.asset.id)
      ) {
        return createServerMediaEntityAccess({ revision: "denied" });
      }
      const [row] = await sql<DeliveryRelationRow[]>`
        SELECT current.id AS "conversationId",
          current.access_state AS "accessState",
          invitation.revision AS "invitationRevision",
          invitation.changed_at AS "invitationChangedAt",
          actor.account_state_changed_at AS "actorStateChangedAt"
        FROM media_assets asset
        JOIN conversation_timeline_entries message
          ON message.id = asset.provenance_entity_id
          AND message.id = ${snapshot.asset.provenanceEntityId}
          AND message.sequence = asset.provenance_entity_revision
          AND message.entry_kind = 'HUMAN_MESSAGE'
          AND message.author_user_id = asset.uploaded_by_user_id
        JOIN current_conversations current
          ON current.id = message.conversation_id
        JOIN current_job_invitations invitation
          ON invitation.id = current.invitation_id
        JOIN customer_profiles customer
          ON customer.id = current.customer_profile_id
        JOIN craftsman_profiles craftsman
          ON craftsman.id = current.craftsman_profile_id
        JOIN users actor ON actor.id = ${snapshot.actor.userId}
          AND actor.account_state = 'ACTIVE'
        WHERE asset.id = ${snapshot.asset.id}
          AND asset.owner_user_id = asset.uploaded_by_user_id
          AND asset.provenance_entity_type = 'CONVERSATION_MESSAGE'
          AND asset.purpose IN ('CHAT_IMAGE', 'CHAT_DOCUMENT')
          AND (customer.owner_user_id = actor.id
            OR craftsman.owner_user_id = actor.id)
      `;
      if (
        row === undefined ||
        !uuidPattern.test(row.conversationId) ||
        !Number.isSafeInteger(row.invitationRevision) ||
        row.invitationRevision < 1 ||
        !(row.actorStateChangedAt instanceof Date) ||
        Number.isNaN(row.actorStateChangedAt.valueOf()) ||
        !(row.invitationChangedAt instanceof Date) ||
        Number.isNaN(row.invitationChangedAt.valueOf()) ||
        (row.accessState !== "WRITABLE" && row.accessState !== "READ_ONLY")
      ) {
        return createServerMediaEntityAccess({ revision: "denied" });
      }
      return createServerMediaEntityAccess({
        grants: ["CONVERSATION_MEMBER"],
        revision: [
          "conversation",
          row.conversationId,
          row.accessState,
          row.invitationRevision,
          row.invitationChangedAt.toISOString(),
          row.actorStateChangedAt.toISOString(),
        ].join(":"),
      });
    },
  });
}
