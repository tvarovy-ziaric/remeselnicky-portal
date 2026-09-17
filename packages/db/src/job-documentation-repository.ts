import type { Sql, TransactionSql } from "postgres";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface JobDocumentationCursor {
  readonly chronologicalAt: Date;
  readonly mediaAssetId: string;
}

export interface JobDocumentationItem {
  readonly mediaAssetId: string;
  readonly kind: "PHOTO" | "DOCUMENT";
  readonly source: "WINNING_CONVERSATION";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly authorRole: "CUSTOMER" | "PRIMARY_PROVIDER";
  readonly uploadedAt: Date;
  readonly capturedAt: Date | null;
  readonly chronologicalAt: Date;
  readonly displayFilename: string | null;
  readonly contentType: string;
  readonly downloadPath: string;
}

export interface JobDocumentationPage {
  readonly items: readonly JobDocumentationItem[];
  readonly nextCursor: JobDocumentationCursor | null;
}

interface Row {
  readonly mediaAssetId: string;
  readonly mediaKind: "IMAGE" | "DOCUMENT";
  readonly sourceMessageId: string;
  readonly uploadedByUserId: string;
  readonly uploadedAt: Date;
  readonly capturedAt: Date | null;
  readonly chronologicalAt: Date;
  readonly displayFilename: string | null;
  readonly contentType: string;
}

export function createJobDocumentationRepository(sql: Sql | TransactionSql) {
  return Object.freeze({
    async listForPrimaryParty(input: {
      readonly actorUserId: string;
      readonly jobId: string;
      readonly category: "ALL" | "PHOTO" | "DOCUMENT";
      readonly cursor?: JobDocumentationCursor;
      readonly limit: number;
    }): Promise<JobDocumentationPage | null> {
      if (
        !uuid.test(input.actorUserId) ||
        !uuid.test(input.jobId) ||
        !["ALL", "PHOTO", "DOCUMENT"].includes(input.category) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        (input.cursor !== undefined &&
          (!uuid.test(input.cursor.mediaAssetId) ||
            !(input.cursor.chronologicalAt instanceof Date) ||
            !Number.isFinite(input.cursor.chronologicalAt.getTime())))
      )
        throw new TypeError("Invalid Job documentation query.");
      return transaction(sql, async (tx) => {
        const [authorized] = await tx<
          Array<{
            id: string;
            customerUserId: string;
            providerUserId: string;
          }>
        >`
          SELECT job.id, customer.owner_user_id AS "customerUserId",
            provider.owner_user_id AS "providerUserId"
          FROM users viewer
          JOIN jobs job ON job.id = ${input.jobId}
          JOIN customer_profiles customer
            ON customer.id = job.customer_profile_id
          JOIN craftsman_profiles provider
            ON provider.id = job.primary_craftsman_profile_id
          JOIN job_acceptance_events accepted ON accepted.job_id = job.id
          JOIN job_agreement_snapshots snapshot ON snapshot.job_id = job.id
          WHERE viewer.id = ${input.actorUserId}
            AND viewer.account_state = 'ACTIVE'
            AND (customer.owner_user_id = viewer.id
              OR provider.owner_user_id = viewer.id)
          FOR SHARE OF viewer
        `;
        if (authorized === undefined) return null;
        const beforeAt = input.cursor?.chronologicalAt ?? null;
        const beforeId = input.cursor?.mediaAssetId ?? null;
        const rows = await tx<Row[]>`
          SELECT media.media_asset_id AS "mediaAssetId",
            media.media_kind::text AS "mediaKind",
            media.source_message_id AS "sourceMessageId",
            media.uploaded_by_user_id AS "uploadedByUserId",
            media.uploaded_at AS "uploadedAt",
            media.captured_at AS "capturedAt",
            media.chronological_at AS "chronologicalAt",
            asset.display_filename AS "displayFilename",
            canonical.content_type AS "contentType"
          FROM job_conversation_media media
          JOIN media_assets asset ON asset.id = media.media_asset_id
            AND asset.status = 'READY'
            AND (asset.kind = 'IMAGE' OR asset.malware_scan_verdict = 'CLEAN')
          JOIN media_asset_storage_objects canonical
            ON canonical.media_asset_id = asset.id
            AND canonical.role = 'CANONICAL'
            AND canonical.storage_area = 'private'
            AND canonical.revoked_at IS NULL
          WHERE media.job_id = ${input.jobId}
            AND (${input.category} = 'ALL'
              OR (${input.category} = 'PHOTO' AND media.media_kind = 'IMAGE')
              OR (${input.category} = 'DOCUMENT'
                AND media.media_kind = 'DOCUMENT'))
            AND (${beforeAt}::timestamptz IS NULL
              OR (media.chronological_at, media.media_asset_id) <
                (${beforeAt}::timestamptz, ${beforeId}::uuid))
          ORDER BY media.chronological_at DESC, media.media_asset_id DESC
          LIMIT ${input.limit + 1}
        `;
        const items = rows
          .slice(0, input.limit)
          .map((row) => toItem(row, authorized));
        const last = rows.length > input.limit ? items.at(-1) : undefined;
        return Object.freeze({
          items: Object.freeze(items),
          nextCursor:
            last === undefined
              ? null
              : Object.freeze({
                  chronologicalAt: last.chronologicalAt,
                  mediaAssetId: last.mediaAssetId,
                }),
        });
      });
    },
  });
}

function toItem(
  row: Row,
  parties: { readonly customerUserId: string; readonly providerUserId: string },
): JobDocumentationItem {
  if (
    !uuid.test(row.mediaAssetId) ||
    !uuid.test(row.sourceMessageId) ||
    !uuid.test(row.uploadedByUserId) ||
    (row.mediaKind !== "IMAGE" && row.mediaKind !== "DOCUMENT") ||
    !(row.uploadedAt instanceof Date) ||
    !(row.chronologicalAt instanceof Date) ||
    !Number.isFinite(row.uploadedAt.getTime()) ||
    !Number.isFinite(row.chronologicalAt.getTime()) ||
    (row.capturedAt !== null &&
      (!(row.capturedAt instanceof Date) ||
        !Number.isFinite(row.capturedAt.getTime()))) ||
    (row.displayFilename !== null && typeof row.displayFilename !== "string") ||
    typeof row.contentType !== "string" ||
    (row.uploadedByUserId !== parties.customerUserId &&
      row.uploadedByUserId !== parties.providerUserId)
  )
    throw new Error("Invalid Job documentation provenance.");
  return Object.freeze({
    mediaAssetId: row.mediaAssetId,
    kind: row.mediaKind === "IMAGE" ? "PHOTO" : "DOCUMENT",
    source: "WINNING_CONVERSATION",
    sourceMessageId: row.sourceMessageId,
    uploadedByUserId: row.uploadedByUserId,
    authorRole:
      row.uploadedByUserId === parties.customerUserId
        ? "CUSTOMER"
        : "PRIMARY_PROVIDER",
    uploadedAt: row.uploadedAt,
    capturedAt: row.capturedAt,
    chronologicalAt: row.chronologicalAt,
    displayFilename: row.displayFilename,
    contentType: row.contentType,
    downloadPath: `/v1/media/${row.mediaAssetId}/download`,
  });
}

function transaction<T>(
  sql: Sql | TransactionSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(callback)
    : sql.begin(callback)) as unknown as Promise<T>;
}
