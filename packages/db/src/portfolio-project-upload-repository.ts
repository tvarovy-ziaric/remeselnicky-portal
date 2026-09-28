import type {
  CraftsmanProfileId,
  PortfolioProjectId,
  UserId,
} from "@portal/domain";
import type {
  PortfolioProjectPhotoUploadAuthorization,
  PortfolioProjectPhotoUploadStatus,
} from "@portal/media";
import type { Sql } from "postgres";

import { preparePortfolioPhotoUpload } from "./portfolio-project-media-repository.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const maximumReturnedUploads = 64;

type ListInput = Parameters<
  PortfolioProjectPhotoUploadAuthorization["listOwnedUploads"]
>[0];
type PrepareInput = Parameters<
  PortfolioProjectPhotoUploadAuthorization["prepareUpload"]
>[0];

export function createPortfolioProjectPhotoUploadAuthorization(
  sql: Sql,
): PortfolioProjectPhotoUploadAuthorization {
  return Object.freeze({
    async listOwnedUploads(
      input: ListInput,
    ): Promise<readonly PortfolioProjectPhotoUploadStatus[]> {
      if (!validIdentity(input)) return [];
      const rows = await sql<
        Array<{
          readonly assetId: string;
          readonly kind: string;
          readonly status: string;
        }>
      >`
        SELECT asset.id AS "assetId", asset.kind, asset.status
        FROM users actor
        JOIN craftsman_profiles profile ON profile.owner_user_id = actor.id
        JOIN portfolio_projects project
          ON project.craftsman_profile_id = profile.id
          AND project.author_user_id = actor.id
        JOIN media_assets asset
          ON asset.owner_user_id = actor.id
          AND asset.uploaded_by_user_id = actor.id
          AND asset.provenance_entity_type = 'PORTFOLIO_PROJECT'
          AND asset.provenance_entity_id = project.id
          AND asset.kind = 'IMAGE'
          AND asset.purpose::text = 'PORTFOLIO_IMAGE'
        WHERE actor.id = ${input.actorUserId}
          AND actor.account_state = 'ACTIVE'
          AND profile.id = ${input.craftsmanProfileId}
          AND project.id = ${input.portfolioProjectId}
        ORDER BY asset.created_at DESC, asset.id DESC
        LIMIT ${maximumReturnedUploads}
      `;
      return Object.freeze(
        rows.map((row) => {
          if (
            !uuidPattern.test(row.assetId) ||
            row.kind !== "IMAGE" ||
            !["PROCESSING", "READY", "REJECTED"].includes(row.status)
          ) {
            throw new Error("Portfolio upload row is invalid.");
          }
          return Object.freeze({
            assetId: row.assetId,
            kind: "IMAGE" as const,
            status: row.status,
          }) as PortfolioProjectPhotoUploadStatus;
        }),
      );
    },
    prepareUpload(input: PrepareInput) {
      if (!validIdentity(input)) {
        return Promise.resolve({ status: "UPLOAD_UNAVAILABLE" } as const);
      }
      return preparePortfolioPhotoUpload(sql, {
        actorUserId: input.actorUserId as UserId,
        craftsmanProfileId: input.craftsmanProfileId as CraftsmanProfileId,
        expectedProjectRevision: input.expectedProjectRevision,
        portfolioProjectId: input.portfolioProjectId as PortfolioProjectId,
      });
    },
  });
}

function validIdentity(input: {
  readonly actorUserId: string;
  readonly craftsmanProfileId: string;
  readonly portfolioProjectId: string;
}): boolean {
  return (
    uuidPattern.test(input.actorUserId) &&
    uuidPattern.test(input.craftsmanProfileId) &&
    uuidPattern.test(input.portfolioProjectId)
  );
}
