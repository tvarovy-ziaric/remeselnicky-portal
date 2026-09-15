import {
  createServerMediaEntityAccess,
  createServerMediaProvenance,
  type MediaEntityAccessResolver,
  type PrivateMediaDeliverySnapshot,
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

interface JobRequestMediaAccessRow {
  readonly contentRevision: number;
  readonly grant: string;
  readonly relationId: string;
  readonly relationRevision: number;
}

export function createJobRequestMediaAccessResolver(
  sql: Sql,
): MediaEntityAccessResolver {
  return Object.freeze({
    async resolvePrivateMediaAccess(snapshot: PrivateMediaDeliverySnapshot) {
      if (
        snapshot.asset.provenanceEntityType !== "JOB_REQUEST" ||
        snapshot.asset.provenanceEntityId === null ||
        !uuidPattern.test(snapshot.asset.provenanceEntityId) ||
        !uuidPattern.test(snapshot.asset.id) ||
        (snapshot.asset.purpose !== "JOB_REQUEST_IMAGE" &&
          snapshot.asset.purpose !== "JOB_REQUEST_DOCUMENT")
      ) {
        return createServerMediaEntityAccess({ revision: "job-request:none" });
      }
      const rows = await sql<JobRequestMediaAccessRow[]>`
        SELECT access.grant AS "grant",
          access.relation_id AS "relationId",
          access.relation_revision AS "relationRevision",
          access.content_revision AS "contentRevision"
        FROM (
          SELECT 'JOB_CUSTOMER'::text AS grant,
            request.id AS relation_id,
            current.revision AS relation_revision,
            current.revision AS content_revision
          FROM users actor
          JOIN customer_profiles customer ON customer.owner_user_id = actor.id
          JOIN job_requests request
            ON request.customer_profile_id = customer.id
            AND request.id = ${snapshot.asset.provenanceEntityId}
          JOIN current_job_requests current ON current.id = request.id
          WHERE actor.id = ${snapshot.actor.userId}
            AND actor.account_state = 'ACTIVE'
            AND actor.id = ${snapshot.asset.ownerUserId}

          UNION ALL

          SELECT 'INVITED_PROVIDER'::text AS grant,
            invitation.id AS relation_id,
            current.revision AS relation_revision,
            allowed.content_revision
          FROM users actor
          JOIN craftsman_profiles profile ON profile.owner_user_id = actor.id
          JOIN job_invitations invitation
            ON invitation.craftsman_profile_id = profile.id
            AND invitation.job_request_id = ${snapshot.asset.provenanceEntityId}
          JOIN current_job_invitations current ON current.id = invitation.id
          CROSS JOIN LATERAL (
            SELECT invitation.request_content_revision AS content_revision
            UNION
            SELECT entitlement.request_content_revision
            FROM job_request_material_update_entitlements entitlement
            WHERE entitlement.invitation_id = invitation.id
              AND entitlement.recipient_user_id = actor.id
              AND entitlement.job_request_id = invitation.job_request_id
          ) allowed
          JOIN LATERAL (
            SELECT section.payload
            FROM job_request_active_section_revisions section
            WHERE section.job_request_id = invitation.job_request_id
              AND section.section_key = 'request.media'
              AND section.content_revision <= allowed.content_revision
            ORDER BY section.content_revision DESC
            LIMIT 1
          ) media ON true
          WHERE actor.id = ${snapshot.actor.userId}
            AND actor.account_state = 'ACTIVE'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                COALESCE(
                  media.payload -> ${snapshot.asset.purpose === "JOB_REQUEST_IMAGE" ? "photoMediaAssetIds" : "documentMediaAssetIds"},
                  '[]'::jsonb
                )
              ) selected(asset_id)
              WHERE selected.asset_id = ${snapshot.asset.id}
            )
        ) access
        ORDER BY access.grant, access.relation_id, access.content_revision
        LIMIT 21
      `;
      if (rows.length === 0 || rows.length > 20) {
        return createServerMediaEntityAccess({ revision: "job-request:none" });
      }
      for (const row of rows) {
        if (
          (row.grant !== "INVITED_PROVIDER" && row.grant !== "JOB_CUSTOMER") ||
          !uuidPattern.test(row.relationId) ||
          !Number.isSafeInteger(row.relationRevision) ||
          row.relationRevision < 1 ||
          !Number.isSafeInteger(row.contentRevision) ||
          row.contentRevision < 1
        ) {
          throw new Error("Job request media access row is invalid.");
        }
      }
      return createServerMediaEntityAccess({
        grants: [...new Set(rows.map((row) => row.grant))] as Array<
          "INVITED_PROVIDER" | "JOB_CUSTOMER"
        >,
        revision: `job-request:${createHash("sha256")
          .update(JSON.stringify(rows))
          .digest("hex")}`,
      });
    },
  });
}
import { createHash } from "node:crypto";
