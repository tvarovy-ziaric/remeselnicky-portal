import {
  createServerMediaProvenance,
  type QuoteDocumentUploadAuthorization,
} from "@portal/media";
import type { Sql } from "postgres";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AttachQuoteSupportingDocumentInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly mediaAssetId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

export interface ReadQuoteSupportingDocumentsInput {
  readonly actorUserId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

export interface QuoteSupportingDocument {
  readonly attachedAt: Date;
  readonly downloadPath: string;
  readonly mediaAssetId: string;
}

export type AttachQuoteSupportingDocumentResult =
  | {
      readonly status:
        | "NOT_FOUND"
        | "DOCUMENT_NOT_READY"
        | "ALREADY_INCLUDED"
        | "DOCUMENT_LIMIT_REACHED";
    }
  | {
      readonly document: QuoteSupportingDocument;
      readonly status: "ATTACHED" | "DEDUPLICATED";
    };

export type RemoveQuoteSupportingDocumentResult = Readonly<{
  status: "REMOVED" | "DEDUPLICATED" | "NOT_FOUND" | "ALREADY_REMOVED";
}>;

export class QuoteSupportingDocumentIdempotencyError extends Error {
  readonly code = "QUOTE_SUPPORTING_DOCUMENT_IDEMPOTENCY_CONFLICT";
}

export function createQuoteSupportingDocumentUploadAuthorization(
  sql: Sql,
): QuoteDocumentUploadAuthorization {
  return Object.freeze({
    async prepareUpload(
      input: Parameters<QuoteDocumentUploadAuthorization["prepareUpload"]>[0],
    ) {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.quoteId) ||
        !Number.isSafeInteger(input.quoteRevision) ||
        input.quoteRevision < 1
      ) {
        return { status: "UPLOAD_UNAVAILABLE" } as const;
      }
      return sql.begin(async (transaction) => {
        const [source] = await transaction<
          Array<{
            conversationId: string;
            invitationId: string;
            jobRequestId: string;
          }>
        >`
          SELECT quote.conversation_id AS "conversationId",
            quote.invitation_id AS "invitationId",
            invitation.job_request_id AS "jobRequestId"
          FROM quotes quote
          JOIN job_invitations invitation ON invitation.id = quote.invitation_id
          JOIN quote_revision_identities revision
            ON revision.quote_id = quote.id
            AND revision.revision = ${input.quoteRevision}
          JOIN craftsman_profiles craftsman
            ON craftsman.id = invitation.craftsman_profile_id
          WHERE quote.id = ${input.quoteId}
            AND craftsman.owner_user_id = ${input.actorUserId}
        `;
        if (source === undefined)
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${source.jobRequestId}::text, 41007)
          )
        `;
        const actor = await transaction`
          SELECT id FROM users WHERE id = ${input.actorUserId}
            AND account_state = 'ACTIVE' FOR UPDATE
        `;
        if (actor.length !== 1)
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        await transaction`
          SELECT id FROM job_invitations
          WHERE id = ${source.invitationId} FOR UPDATE
        `;
        await transaction`
          SELECT id FROM conversations
          WHERE id = ${source.conversationId} FOR UPDATE
        `;
        await transaction`
          SELECT id FROM quotes WHERE id = ${input.quoteId} FOR UPDATE
        `;
        const draft = await transaction`
          SELECT head.quote_id FROM quote_revision_heads head
          WHERE head.quote_id = ${input.quoteId}
            AND head.quote_revision = ${input.quoteRevision}
            AND head.state = 'DRAFT'
            AND quote_active_participant_context(
              ${source.conversationId}, ${input.actorUserId},
              'CRAFTSMAN', true
            )
          FOR UPDATE OF head
        `;
        if (draft.length !== 1)
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        return {
          provenance: createServerMediaProvenance({
            entityId: input.quoteId,
            entityRevision: input.quoteRevision,
            entityType: "QUOTE_REVISION",
          }),
          purpose: "QUOTE_DOCUMENT",
          status: "AUTHORIZED",
        } as const;
      });
    },
  });
}

interface BindingRow {
  readonly actorUserId: string;
  readonly attachedAt: Date;
  readonly mediaAssetId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

interface RemovalRow {
  readonly actorUserId: string;
  readonly mediaAssetId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

export function createQuoteSupportingDocumentRepository(sql: Sql) {
  return Object.freeze({
    async attach(
      input: AttachQuoteSupportingDocumentInput,
    ): Promise<AttachQuoteSupportingDocumentResult> {
      assertAttach(input);
      try {
        return await sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${input.commandId}::text, 50002)
            )
          `;
          const [source] = await transaction<Array<{ jobRequestId: string }>>`
            SELECT invitation.job_request_id AS "jobRequestId"
            FROM quotes quote
            JOIN job_invitations invitation ON invitation.id = quote.invitation_id
            JOIN craftsman_profiles craftsman
              ON craftsman.id = invitation.craftsman_profile_id
            JOIN users actor ON actor.id = craftsman.owner_user_id
              AND actor.account_state = 'ACTIVE'
            JOIN quote_revision_identities revision
              ON revision.quote_id = quote.id
              AND revision.revision = ${input.quoteRevision}
            WHERE quote.id = ${input.quoteId}
              AND actor.id = ${input.actorUserId}
          `;
          if (source === undefined) return { status: "NOT_FOUND" } as const;
          await transaction`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${source.jobRequestId}::text, 41007)
            )
          `;
          const [existing] = await transaction<BindingRow[]>`
            SELECT attachment.attached_by_user_id AS "actorUserId",
              attachment.attached_at AS "attachedAt",
              attachment.media_asset_id AS "mediaAssetId",
              attachment.quote_id AS "quoteId",
              attachment.quote_revision AS "quoteRevision"
            FROM quote_revision_supporting_documents attachment
            WHERE attachment.attachment_command_id = ${input.commandId}
          `;
          if (existing !== undefined) {
            if (
              existing.actorUserId !== input.actorUserId ||
              existing.mediaAssetId !== input.mediaAssetId ||
              existing.quoteId !== input.quoteId ||
              existing.quoteRevision !== input.quoteRevision
            ) {
              throw new QuoteSupportingDocumentIdempotencyError(
                "Supporting-document command reused with another intent.",
              );
            }
            return {
              document: toDocument(existing),
              status: "DEDUPLICATED",
            } as const;
          }
          const [attached] = await transaction<BindingRow[]>`
            INSERT INTO quote_revision_supporting_documents (
              quote_id, quote_revision, media_asset_id,
              attachment_command_id, attached_by_user_id,
              content_sha256, attached_at
            ) VALUES (
              ${input.quoteId}, ${input.quoteRevision},
              ${input.mediaAssetId}, ${input.commandId}, ${input.actorUserId},
              ${"0".repeat(64)}, clock_timestamp()
            ) RETURNING attached_by_user_id AS "actorUserId",
              attached_at AS "attachedAt",
              media_asset_id AS "mediaAssetId", quote_id AS "quoteId",
              quote_revision AS "quoteRevision"
          `;
          if (attached === undefined)
            throw new Error("Supporting document binding missing.");
          return {
            document: toDocument(attached),
            status: "ATTACHED",
          } as const;
        });
      } catch (error) {
        if (error instanceof QuoteSupportingDocumentIdempotencyError)
          throw error;
        const message = error instanceof Error ? error.message : "";
        if (/exact READY private Quote supporting PDF required/u.test(message))
          return { status: "DOCUMENT_NOT_READY" };
        if (/Quote supporting document limit reached/u.test(message))
          return { status: "DOCUMENT_LIMIT_REACHED" };
        if (
          /owned draft Quote required|active Quote provider required/u.test(
            message,
          )
        )
          return { status: "NOT_FOUND" };
        if (isUniqueViolation(error)) return { status: "ALREADY_INCLUDED" };
        throw error;
      }
    },
    async remove(
      input: AttachQuoteSupportingDocumentInput,
    ): Promise<RemoveQuoteSupportingDocumentResult> {
      assertAttach(input);
      try {
        return await sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${input.commandId}::text, 50003)
            )
          `;
          const [source] = await transaction<Array<{ jobRequestId: string }>>`
            SELECT invitation.job_request_id AS "jobRequestId"
            FROM quotes quote
            JOIN job_invitations invitation ON invitation.id = quote.invitation_id
            JOIN craftsman_profiles craftsman
              ON craftsman.id = invitation.craftsman_profile_id
            JOIN users actor ON actor.id = craftsman.owner_user_id
              AND actor.account_state = 'ACTIVE'
            WHERE quote.id = ${input.quoteId}
              AND actor.id = ${input.actorUserId}
          `;
          if (source === undefined) return { status: "NOT_FOUND" } as const;
          await transaction`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${source.jobRequestId}::text, 41007)
            )
          `;
          const [existing] = await transaction<RemovalRow[]>`
            SELECT removed_by_user_id AS "actorUserId",
              media_asset_id AS "mediaAssetId", quote_id AS "quoteId",
              quote_revision AS "quoteRevision"
            FROM quote_revision_supporting_document_removals
            WHERE removal_command_id = ${input.commandId}
          `;
          if (existing !== undefined) {
            if (
              existing.actorUserId !== input.actorUserId ||
              existing.mediaAssetId !== input.mediaAssetId ||
              existing.quoteId !== input.quoteId ||
              existing.quoteRevision !== input.quoteRevision
            ) {
              throw new QuoteSupportingDocumentIdempotencyError(
                "Supporting-document removal command reused with another intent.",
              );
            }
            return { status: "DEDUPLICATED" } as const;
          }
          await transaction`
            INSERT INTO quote_revision_supporting_document_removals (
              quote_id, quote_revision, media_asset_id,
              removal_command_id, removed_by_user_id, removed_at
            ) VALUES (
              ${input.quoteId}, ${input.quoteRevision},
              ${input.mediaAssetId}, ${input.commandId},
              ${input.actorUserId}, clock_timestamp()
            )
          `;
          return { status: "REMOVED" } as const;
        });
      } catch (error) {
        if (error instanceof QuoteSupportingDocumentIdempotencyError)
          throw error;
        const message = error instanceof Error ? error.message : "";
        if (/owned draft Quote/u.test(message)) return { status: "NOT_FOUND" };
        if (isUniqueViolation(error)) return { status: "ALREADY_REMOVED" };
        throw error;
      }
    },
    async readOwned(
      input: ReadQuoteSupportingDocumentsInput,
    ): Promise<readonly QuoteSupportingDocument[] | null> {
      assertRead(input);
      return sql.begin(async (transaction) => {
        const [access] = await transaction<Array<{ id: string }>>`
        SELECT quote.id
        FROM quotes quote
        JOIN quote_revision_identities revision
          ON revision.quote_id = quote.id
          AND revision.revision = ${input.quoteRevision}
        JOIN quote_revision_heads head ON head.quote_id = quote.id
          AND head.quote_revision = revision.revision
        JOIN current_conversations conversation
          ON conversation.id = quote.conversation_id
        JOIN customer_profiles customer
          ON customer.id = conversation.customer_profile_id
        JOIN craftsman_profiles craftsman
          ON craftsman.id = conversation.craftsman_profile_id
        JOIN users actor ON actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
        WHERE quote.id = ${input.quoteId}
          AND (craftsman.owner_user_id = actor.id
            OR (customer.owner_user_id = actor.id AND head.state <> 'DRAFT'))
        FOR SHARE OF actor
        `;
        if (access === undefined) return null;
        const [expected] = await transaction<Array<{ count: number }>>`
          SELECT count(*)::integer AS count
          FROM current_quote_revision_supporting_documents attachment
          WHERE attachment.quote_id = ${input.quoteId}
            AND attachment.quote_revision = ${input.quoteRevision}
        `;
        if (expected === undefined) return null;
        const rows = await transaction<BindingRow[]>`
        SELECT attachment.attached_by_user_id AS "actorUserId",
          attachment.attached_at AS "attachedAt",
          attachment.media_asset_id AS "mediaAssetId",
          attachment.quote_id AS "quoteId",
          attachment.quote_revision AS "quoteRevision"
        FROM current_quote_revision_supporting_documents attachment
        JOIN media_assets asset ON asset.id = attachment.media_asset_id
          AND asset.status = 'READY'
          AND asset.malware_scan_verdict = 'CLEAN'
          AND asset.document_content_sha256 = attachment.content_sha256
        JOIN media_asset_storage_objects canonical
          ON canonical.media_asset_id = asset.id
          AND canonical.role = 'CANONICAL'
          AND canonical.storage_area = 'private'
          AND canonical.content_type = 'application/pdf'
          AND canonical.content_sha256 = attachment.content_sha256
          AND canonical.revoked_at IS NULL
        WHERE attachment.quote_id = ${input.quoteId}
          AND attachment.quote_revision = ${input.quoteRevision}
        ORDER BY attachment.attached_at, attachment.media_asset_id
        FOR SHARE OF asset, canonical
        `;
        if (rows.length !== expected.count) return null;
        return Object.freeze(rows.map(toDocument));
      });
    },
  });
}

function toDocument(row: BindingRow): QuoteSupportingDocument {
  return Object.freeze({
    attachedAt: row.attachedAt,
    downloadPath: `/v1/media/${row.mediaAssetId}/download`,
    mediaAssetId: row.mediaAssetId,
  });
}

function assertRead(input: ReadQuoteSupportingDocumentsInput): void {
  if (
    !uuidPattern.test(input.actorUserId) ||
    !uuidPattern.test(input.quoteId) ||
    !Number.isSafeInteger(input.quoteRevision) ||
    input.quoteRevision < 1
  ) {
    throw new TypeError("Invalid Quote supporting-document read.");
  }
}

function assertAttach(input: AttachQuoteSupportingDocumentInput): void {
  assertRead(input);
  if (
    !uuidPattern.test(input.commandId) ||
    !uuidPattern.test(input.mediaAssetId)
  )
    throw new TypeError("Invalid Quote supporting-document attachment.");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  );
}
