import type {
  CreateProcessingMediaAssetInput,
  MediaAssetRepository,
  MediaProcessingTransitionResult,
  ProcessingMediaAsset,
} from "@portal/media";
import type { Sql } from "postgres";

export type {
  CreateProcessingMediaAssetInput,
  MediaProcessingTransitionResult,
  ProcessingMediaAsset,
} from "@portal/media";

export type MediaRepository = MediaAssetRepository;

interface ProcessingMediaAssetRow {
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly declaredContentType: string;
  readonly displayFilename: string | null;
  readonly id: string;
  readonly kind: ProcessingMediaAsset["kind"];
  readonly ownerUserId: string;
  readonly provenanceEntityId: string | null;
  readonly provenanceEntityRevision: number | null;
  readonly provenanceEntityType: ProcessingMediaAsset["provenanceEntityType"];
  readonly purpose: ProcessingMediaAsset["purpose"];
  readonly status: "PROCESSING";
  readonly updatedAt: Date;
  readonly uploaderUserId: string;
}

interface MediaProcessingTransitionRow {
  readonly assetId: string;
  readonly statusChangedAt: Date;
}

const rejectionCodePattern = /^[A-Z][A-Z0-9_]{0,79}$/u;
const assetIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createMediaRepository(sql: Sql): MediaRepository {
  return Object.freeze({
    async createProcessingAsset(
      input: CreateProcessingMediaAssetInput,
    ): Promise<ProcessingMediaAsset> {
      if (input.storageObject.area !== "private") {
        throw new Error("New uploads must enter private processing storage.");
      }

      const result = await sql.begin(async (transaction) => {
        const [asset] = await transaction<ProcessingMediaAssetRow[]>`
          INSERT INTO media_assets (
            owner_user_id,
            uploaded_by_user_id,
            kind,
            purpose,
            declared_content_type,
            display_filename,
            byte_size,
            provenance_entity_type,
            provenance_entity_id,
            provenance_entity_revision
          ) VALUES (
            ${input.ownerUserId},
            ${input.uploaderUserId},
            ${input.kind},
            ${input.purpose},
            ${input.declaredContentType},
            ${input.displayFilename},
            ${input.byteSize},
            ${input.provenanceEntityType},
            ${input.provenanceEntityId},
            ${input.provenanceEntityRevision}
          )
          RETURNING
            id,
            owner_user_id AS "ownerUserId",
            uploaded_by_user_id AS "uploaderUserId",
            kind,
            purpose,
            status,
            declared_content_type AS "declaredContentType",
            display_filename AS "displayFilename",
            byte_size AS "byteSize",
            provenance_entity_type AS "provenanceEntityType",
            provenance_entity_id AS "provenanceEntityId",
            provenance_entity_revision AS "provenanceEntityRevision",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `;
        if (asset === undefined) {
          throw new Error("Media asset was not created.");
        }

        await transaction`
          INSERT INTO media_asset_storage_objects (
            media_asset_id,
            role,
            storage_area,
            storage_key,
            content_type,
            byte_size
          ) VALUES (
            ${asset.id},
            'ORIGINAL_UPLOAD',
            ${input.storageObject.area},
            ${input.storageObject.key},
            ${input.declaredContentType},
            ${input.byteSize}
          )
        `;

        return asset;
      });

      return Object.freeze({
        ...result,
        storageObject: Object.freeze({
          area: input.storageObject.area,
          key: input.storageObject.key,
        }),
      });
    },

    async recordMediaProcessingSucceeded(
      assetId: string,
    ): Promise<MediaProcessingTransitionResult> {
      if (!assetIdPattern.test(assetId)) {
        return Object.freeze({ transition: "NOT_PROCESSING" as const });
      }
      const [asset] = await sql<MediaProcessingTransitionRow[]>`
        UPDATE media_assets
        SET
          status = 'READY',
          status_changed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          ready_at = CURRENT_TIMESTAMP
        WHERE id = ${assetId}
          AND status = 'PROCESSING'
        RETURNING
          id AS "assetId",
          status_changed_at AS "statusChangedAt"
      `;
      return asset === undefined
        ? Object.freeze({ transition: "NOT_PROCESSING" as const })
        : Object.freeze({
            ...asset,
            rejectionCode: null,
            status: "READY" as const,
            transition: "UPDATED" as const,
          });
    },

    async recordMediaProcessingRejected(input: {
      readonly assetId: string;
      readonly rejectionCode: string;
    }): Promise<MediaProcessingTransitionResult> {
      if (!rejectionCodePattern.test(input.rejectionCode)) {
        throw new Error(
          "Media rejection code must be a stable safe identifier.",
        );
      }
      if (!assetIdPattern.test(input.assetId)) {
        return Object.freeze({ transition: "NOT_PROCESSING" as const });
      }
      const [asset] = await sql<MediaProcessingTransitionRow[]>`
        UPDATE media_assets
        SET
          status = 'REJECTED',
          status_changed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          rejected_at = CURRENT_TIMESTAMP,
          rejection_code = ${input.rejectionCode}
        WHERE id = ${input.assetId}
          AND status = 'PROCESSING'
        RETURNING
          id AS "assetId",
          status_changed_at AS "statusChangedAt"
      `;
      return asset === undefined
        ? Object.freeze({ transition: "NOT_PROCESSING" as const })
        : Object.freeze({
            ...asset,
            rejectionCode: input.rejectionCode,
            status: "REJECTED" as const,
            transition: "UPDATED" as const,
          });
    },
  });
}
