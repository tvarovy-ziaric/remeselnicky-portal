import { createHash } from "node:crypto";

import { createServerMediaProvenance } from "@portal/media";
import type { Sql, TransactionSql } from "postgres";

import { ChangeOrderIdempotencyError } from "./change-order-repository.js";

type RootSql = Sql | TransactionSql;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export interface ReserveChangeOrderPdfUploadInput {
  readonly actorUserId: string;
  readonly commandId: string;
  readonly jobId: string;
  readonly changeOrderId: string;
  readonly revisionId: string;
  readonly expectedRevisionId: string | null;
}
export type ReserveChangeOrderPdfUploadResult =
  | Readonly<{
      status: "AUTHORIZED" | "DEDUPLICATED";
      reservationId: string;
      revisionNumber: number;
      expiresAt: Date;
    }>
  | Readonly<{ status: "NOT_FOUND" | "STALE_STATE" }>;
export type PrepareChangeOrderPdfUploadResult =
  | Readonly<{
      status: "AUTHORIZED";
      purpose: "CHANGE_ORDER_DOCUMENT";
      provenance: ReturnType<typeof createServerMediaProvenance>;
    }>
  | Readonly<{ status: "UPLOAD_UNAVAILABLE" }>;
export type ChangeOrderPdfUploadStatus = Readonly<{
  status: "PROCESSING" | "READY" | "REJECTED";
  expiresAt: Date;
  canCreateRevision: boolean;
}>;

export function createChangeOrderPdfUploadRepository(sql: RootSql) {
  async function reserve(
    input: ReserveChangeOrderPdfUploadInput,
  ): Promise<ReserveChangeOrderPdfUploadResult> {
    ids(
      input.actorUserId,
      input.commandId,
      input.jobId,
      input.changeOrderId,
      input.revisionId,
    );
    if (input.expectedRevisionId) ids(input.expectedRevisionId);
    if (
      input.expectedRevisionId === null
        ? input.commandId !== input.changeOrderId
        : input.commandId !== input.revisionId
    )
      throw new TypeError(
        "PDF reservation must use its future Change-order command ID.",
      );
    const intent = createHash("sha256")
      .update(
        JSON.stringify({
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          jobId: input.jobId,
          changeOrderId: input.changeOrderId,
          revisionId: input.revisionId,
          expectedRevisionId: input.expectedRevisionId,
        }),
      )
      .digest("hex");
    return transaction(sql, async (tx) => {
      const [job] = await tx<Array<{ state: string; side: string | null }>>`
        SELECT state.state::text AS state,
          change_order_actor_side(job.id, ${input.actorUserId}::uuid)::text AS side
        FROM jobs job JOIN current_job_states state ON state.job_id = job.id
        WHERE job.id = ${input.jobId} FOR UPDATE OF job`;
      if (!job || job.side !== "PRIMARY_PROVIDER")
        return { status: "NOT_FOUND" };
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.commandId}::text, 51013))`;
      const [prior] = await tx<
        Array<{
          id: string;
          jobId: string;
          changeOrderId: string;
          revisionId: string;
          expectedRevisionId: string | null;
          providerUserId: string;
          intent: string;
          revisionNumber: number;
          expiresAt: Date;
        }>
      >`
        SELECT id, job_id AS "jobId", change_order_id AS "changeOrderId",
          revision_id AS "revisionId", expected_revision_id AS "expectedRevisionId",
          provider_user_id AS "providerUserId", command_intent_sha256 AS intent,
          revision_number AS "revisionNumber", expires_at AS "expiresAt"
        FROM change_order_pdf_upload_reservations WHERE id = ${input.commandId}`;
      if (prior) {
        if (
          prior.intent !== intent ||
          prior.jobId !== input.jobId ||
          prior.changeOrderId !== input.changeOrderId ||
          prior.revisionId !== input.revisionId ||
          prior.expectedRevisionId !== input.expectedRevisionId ||
          prior.providerUserId !== input.actorUserId
        )
          throw new ChangeOrderIdempotencyError(
            "PDF reservation ID reused with different intent.",
          );
        return prior.expiresAt > new Date()
          ? {
              status: "DEDUPLICATED",
              reservationId: prior.id,
              revisionNumber: prior.revisionNumber,
              expiresAt: prior.expiresAt,
            }
          : { status: "STALE_STATE" };
      }
      if (job.state !== "CONFIRMED" && job.state !== "IN_PROGRESS")
        return { status: "STALE_STATE" };
      const [head] = await tx<
        Array<{
          revisionId: string;
          revisionNumber: number;
          state: string;
          authoredSide: string;
        }>
      >`
        SELECT current.revision_id AS "revisionId",
          current.revision_number AS "revisionNumber", current.state::text AS state,
          revision.authored_side::text AS "authoredSide"
        FROM current_change_orders current
        JOIN change_order_revisions revision ON revision.id = current.revision_id
        WHERE current.id = ${input.changeOrderId} AND current.job_id = ${input.jobId}`;
      const [identity] = await tx<Array<{ id: string }>>`
        SELECT id FROM change_orders WHERE id = ${input.changeOrderId}`;
      const eligible = head
        ? input.expectedRevisionId === head.revisionId &&
          ((head.state === "DRAFT" &&
            head.authoredSide === "PRIMARY_PROVIDER") ||
            (head.state === "PROPOSED" && head.authoredSide === "CUSTOMER"))
        : !identity && input.expectedRevisionId === null;
      if (!eligible) return { status: "STALE_STATE" };
      const revisionNumber = (head?.revisionNumber ?? 0) + 1;
      const [created] = await tx<Array<{ expiresAt: Date }>>`
        INSERT INTO change_order_pdf_upload_reservations
          (id, job_id, change_order_id, revision_id, expected_revision_id,
            revision_number, provider_user_id, command_intent_sha256)
        VALUES (${input.commandId}, ${input.jobId}, ${input.changeOrderId},
          ${input.revisionId}, ${input.expectedRevisionId}::uuid,
          ${revisionNumber}, ${input.actorUserId}, ${intent})
        RETURNING expires_at AS "expiresAt"`;
      if (!created) throw new Error("Change-order PDF reservation missing.");
      return {
        status: "AUTHORIZED",
        reservationId: input.commandId,
        revisionNumber,
        expiresAt: created.expiresAt,
      };
    });
  }

  async function prepareUpload(input: {
    actorUserId: string;
    jobId: string;
    revisionId: string;
  }): Promise<PrepareChangeOrderPdfUploadResult> {
    ids(input.actorUserId, input.jobId, input.revisionId);
    const [row] = await sql<Array<{ revisionNumber: number }>>`
      SELECT reservation.revision_number AS "revisionNumber"
      FROM change_order_pdf_upload_reservations reservation
      JOIN jobs job ON job.id = reservation.job_id
      JOIN current_job_states state ON state.job_id = job.id
      WHERE reservation.job_id = ${input.jobId}
        AND reservation.revision_id = ${input.revisionId}
        AND reservation.provider_user_id = ${input.actorUserId}
        AND reservation.expires_at > clock_timestamp()
        AND state.state IN ('CONFIRMED', 'IN_PROGRESS')
        AND change_order_actor_side(job.id, ${input.actorUserId}::uuid) = 'PRIMARY_PROVIDER'
        AND NOT EXISTS (SELECT 1 FROM change_order_pdf_reserved_assets bound
          WHERE bound.reservation_id = reservation.id)
        AND NOT EXISTS (SELECT 1 FROM change_order_revisions revision
          WHERE revision.id = reservation.revision_id)
        AND ((reservation.expected_revision_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM change_orders identity
            WHERE identity.id = reservation.change_order_id))
          OR EXISTS (SELECT 1 FROM current_change_orders current
            JOIN change_order_revisions revision ON revision.id = current.revision_id
            WHERE current.id = reservation.change_order_id
              AND current.job_id = reservation.job_id
              AND current.revision_id = reservation.expected_revision_id
              AND current.revision_number + 1 = reservation.revision_number
              AND ((current.state = 'DRAFT' AND revision.authored_side = 'PRIMARY_PROVIDER')
                OR (current.state = 'PROPOSED' AND revision.authored_side = 'CUSTOMER'))))`;
    if (!row) return { status: "UPLOAD_UNAVAILABLE" };
    return {
      status: "AUTHORIZED",
      purpose: "CHANGE_ORDER_DOCUMENT",
      provenance: createServerMediaProvenance({
        entityType: "CHANGE_ORDER_REVISION",
        entityId: input.revisionId,
        entityRevision: row.revisionNumber,
      }),
    };
  }

  async function readStatus(input: {
    actorUserId: string;
    jobId: string;
    revisionId: string;
    mediaAssetId: string;
  }): Promise<ChangeOrderPdfUploadStatus | null> {
    ids(input.actorUserId, input.jobId, input.revisionId, input.mediaAssetId);
    const [row] = await sql<
      Array<{
        status: "PROCESSING" | "READY" | "REJECTED";
        expiresAt: Date;
        jobOpen: boolean;
        headValid: boolean;
        revisionAbsent: boolean;
        canonicalReady: boolean;
      }>
    >`
      SELECT asset.status::text AS status,
        reservation.expires_at AS "expiresAt",
        state.state IN ('CONFIRMED', 'IN_PROGRESS') AS "jobOpen",
        CASE WHEN reservation.expected_revision_id IS NULL THEN
          NOT EXISTS (SELECT 1 FROM change_orders identity
            WHERE identity.id = reservation.change_order_id)
        ELSE EXISTS (
          SELECT 1 FROM current_change_orders current
          JOIN change_order_revisions revision ON revision.id = current.revision_id
          WHERE current.id = reservation.change_order_id
            AND current.job_id = reservation.job_id
            AND current.revision_id = reservation.expected_revision_id
            AND current.revision_number + 1 = reservation.revision_number
            AND ((current.state = 'DRAFT' AND revision.authored_side = 'PRIMARY_PROVIDER')
              OR (current.state = 'PROPOSED' AND revision.authored_side = 'CUSTOMER')))
        END AS "headValid",
        NOT EXISTS (SELECT 1 FROM change_order_revisions consumed
          WHERE consumed.id = reservation.revision_id) AS "revisionAbsent",
        (asset.status = 'READY' AND asset.kind = 'DOCUMENT'
          AND asset.malware_scan_verdict = 'CLEAN'
          AND asset.document_content_sha256 IS NOT NULL
          AND EXISTS (SELECT 1 FROM media_asset_storage_objects canonical
            WHERE canonical.media_asset_id = asset.id AND canonical.role = 'CANONICAL'
              AND canonical.storage_area = 'private'
              AND canonical.content_type = 'application/pdf'
              AND canonical.content_sha256 = asset.document_content_sha256
              AND canonical.revoked_at IS NULL)) AS "canonicalReady"
      FROM change_order_pdf_upload_reservations reservation
      JOIN jobs job ON job.id = reservation.job_id
      JOIN current_job_states state ON state.job_id = job.id
      JOIN change_order_pdf_reserved_assets bound ON bound.reservation_id = reservation.id
      JOIN media_assets asset ON asset.id = bound.media_asset_id
      WHERE reservation.job_id = ${input.jobId}
        AND reservation.revision_id = ${input.revisionId}
        AND reservation.provider_user_id = ${input.actorUserId}
        AND asset.id = ${input.mediaAssetId}
        AND asset.owner_user_id = ${input.actorUserId}
        AND asset.uploaded_by_user_id = ${input.actorUserId}
        AND asset.purpose = 'CHANGE_ORDER_DOCUMENT'
        AND asset.kind = 'DOCUMENT'
        AND asset.declared_content_type = 'application/pdf'
        AND asset.provenance_entity_type = 'CHANGE_ORDER_REVISION'
        AND asset.provenance_entity_id = reservation.revision_id
        AND asset.provenance_entity_revision = reservation.revision_number
        AND change_order_actor_side(job.id, ${input.actorUserId}::uuid) = 'PRIMARY_PROVIDER'
        AND EXISTS (SELECT 1 FROM media_asset_storage_objects original
          WHERE original.media_asset_id = asset.id
            AND original.role = 'ORIGINAL_UPLOAD'
            AND original.storage_area = 'private')`;
    if (!row) return null;
    return {
      status: row.status,
      expiresAt: row.expiresAt,
      canCreateRevision:
        row.jobOpen &&
        row.headValid &&
        row.revisionAbsent &&
        row.canonicalReady &&
        row.expiresAt > new Date(),
    };
  }

  return Object.freeze({ reserve, prepareUpload, readStatus });
}
function ids(...values: string[]): void {
  if (values.some((value) => typeof value !== "string" || !uuid.test(value)))
    throw new TypeError("Invalid Change-order PDF identity.");
}
async function transaction<T>(
  sql: RootSql,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return ("savepoint" in sql
    ? sql.savepoint(work)
    : sql.begin(work)) as unknown as Promise<T>;
}
