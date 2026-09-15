import {
  createServerMediaProvenance,
  type JobRequestMediaUploadAuthorization,
  type JobRequestMediaUploadStatus,
  type PrepareJobRequestMediaUploadResult,
} from "@portal/media";
import type { Sql } from "postgres";

interface CurrentRevisionRow {
  readonly revision: number;
  readonly state: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ListOwnedUploadsInput = Parameters<
  JobRequestMediaUploadAuthorization["listOwnedUploads"]
>[0];
type PrepareUploadInput = Parameters<
  JobRequestMediaUploadAuthorization["prepareUpload"]
>[0];

export function createJobRequestMediaUploadAuthorization(
  sql: Sql,
): JobRequestMediaUploadAuthorization {
  return Object.freeze({
    async listOwnedUploads(
      input: ListOwnedUploadsInput,
    ): Promise<readonly JobRequestMediaUploadStatus[]> {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.jobRequestId)
      ) {
        return [];
      }
      const rows = await sql<
        Array<{
          readonly assetId: string;
          readonly kind: string;
          readonly status: string;
        }>
      >`
        SELECT asset.id AS "assetId", asset.kind, asset.status
        FROM users actor
        JOIN customer_profiles customer ON customer.owner_user_id = actor.id
        JOIN job_requests request ON request.customer_profile_id = customer.id
        JOIN media_assets asset
          ON asset.owner_user_id = actor.id
          AND asset.provenance_entity_type = 'JOB_REQUEST'
          AND asset.provenance_entity_id = request.id
        WHERE actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
          AND request.id = ${input.jobRequestId}
          AND (
            (asset.kind = 'IMAGE' AND asset.purpose::text = 'JOB_REQUEST_IMAGE')
            OR (asset.kind = 'DOCUMENT'
              AND asset.purpose::text = 'JOB_REQUEST_DOCUMENT')
          )
        ORDER BY asset.created_at, asset.id
        LIMIT 139
      `;
      if (rows.length > 138) {
        throw new Error("Job request media result exceeds its safety bound.");
      }
      return Object.freeze(
        rows.map((row) => {
          if (
            !uuidPattern.test(row.assetId) ||
            (row.kind !== "IMAGE" && row.kind !== "DOCUMENT") ||
            !["PROCESSING", "READY", "REJECTED"].includes(row.status)
          ) {
            throw new Error("Job request media row is invalid.");
          }
          return Object.freeze({
            assetId: row.assetId,
            kind: row.kind,
            status: row.status,
          }) as JobRequestMediaUploadStatus;
        }),
      );
    },
    async prepareUpload(
      input: PrepareUploadInput,
    ): Promise<PrepareJobRequestMediaUploadResult> {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.jobRequestId) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 ||
        (input.mediaKind !== "IMAGE" && input.mediaKind !== "DOCUMENT")
      ) {
        return { status: "UPLOAD_UNAVAILABLE" };
      }
      return sql.begin(async (transaction) => {
        const [customer] = await transaction<Array<{ readonly id: string }>>`
          SELECT customer.id
          FROM users actor
          JOIN customer_profiles customer ON customer.owner_user_id = actor.id
          WHERE actor.id = ${input.actorUserId}
            AND actor.account_state = 'ACTIVE'
          FOR UPDATE OF actor, customer
        `;
        if (customer === undefined) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        const requests = await transaction`
          SELECT id
          FROM job_requests
          WHERE id = ${input.jobRequestId}
            AND customer_profile_id = ${customer.id}
          FOR UPDATE
        `;
        if (requests.length !== 1) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        const [current] = await transaction<CurrentRevisionRow[]>`
          SELECT revision, state
          FROM job_request_revisions
          WHERE job_request_id = ${input.jobRequestId}
          ORDER BY revision DESC
          LIMIT 1
          FOR UPDATE
        `;
        if (
          current === undefined ||
          current.state !== "DRAFT" ||
          current.revision !== input.expectedRevision
        ) {
          return { status: "UPLOAD_UNAVAILABLE" } as const;
        }
        return Object.freeze({
          provenance: createServerMediaProvenance({
            entityId: input.jobRequestId,
            entityRevision: current.revision,
            entityType: "JOB_REQUEST",
          }),
          purpose:
            input.mediaKind === "IMAGE"
              ? ("JOB_REQUEST_IMAGE" as const)
              : ("JOB_REQUEST_DOCUMENT" as const),
          status: "AUTHORIZED" as const,
        });
      });
    },
  });
}
