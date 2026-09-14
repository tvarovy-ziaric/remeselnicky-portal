import type {
  CompleteDocumentProcessingInput,
  CompleteImageProcessingInput,
  CreateProcessingMediaAssetInput,
  DocumentProcessingAssetSource,
  DocumentProcessingCompletionResult,
  DocumentProcessingRepository,
  ImageProcessingAssetSource,
  ImageProcessingCompletionResult,
  ImageProcessingRepository,
  MediaAssetRepository,
  MediaProcessingTransitionResult,
  ProcessingMediaAsset,
} from "@portal/media";
import type { Sql } from "postgres";

export type {
  CompleteDocumentProcessingInput,
  CompleteImageProcessingInput,
  CreateProcessingMediaAssetInput,
  DocumentProcessingAssetSource,
  DocumentProcessingCompletionResult,
  ImageProcessingAssetSource,
  ImageProcessingCompletionResult,
  MediaProcessingTransitionResult,
  ProcessingMediaAsset,
} from "@portal/media";

export type MediaRepository = MediaAssetRepository &
  ImageProcessingRepository &
  DocumentProcessingRepository;

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

interface ImageProcessingSourceRow {
  readonly declaredContentType: string;
  readonly id: string;
  readonly kind: ImageProcessingAssetSource["kind"];
  readonly status: ImageProcessingAssetSource["status"];
  readonly storageArea: ImageProcessingAssetSource["originalStorageObject"]["area"];
  readonly storageKey: string;
}

type DocumentProcessingSourceRow = ImageProcessingSourceRow;

interface LockedMediaAssetRow {
  readonly id: string;
  readonly kind: ImageProcessingAssetSource["kind"];
  readonly status: ImageProcessingAssetSource["status"];
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

    async findImageProcessingSource(
      assetId: string,
    ): Promise<ImageProcessingAssetSource | null> {
      if (!assetIdPattern.test(assetId)) return null;
      const [source] = await sql<ImageProcessingSourceRow[]>`
        SELECT
          asset.id,
          asset.kind,
          asset.status,
          asset.declared_content_type AS "declaredContentType",
          object.storage_area AS "storageArea",
          object.storage_key AS "storageKey"
        FROM media_assets AS asset
        INNER JOIN media_asset_storage_objects AS object
          ON object.media_asset_id = asset.id
          AND object.role = 'ORIGINAL_UPLOAD'
          AND object.revoked_at IS NULL
        WHERE asset.id = ${assetId}
      `;
      if (source === undefined) return null;
      return Object.freeze({
        declaredContentType: source.declaredContentType,
        id: source.id,
        kind: source.kind,
        originalStorageObject: Object.freeze({
          area: source.storageArea,
          key: source.storageKey as ImageProcessingAssetSource["originalStorageObject"]["key"],
        }),
        status: source.status,
      });
    },

    async findDocumentProcessingSource(
      assetId: string,
    ): Promise<DocumentProcessingAssetSource | null> {
      if (!assetIdPattern.test(assetId)) return null;
      const [source] = await sql<DocumentProcessingSourceRow[]>`
        SELECT
          asset.id,
          asset.kind,
          asset.status,
          asset.declared_content_type AS "declaredContentType",
          object.storage_area AS "storageArea",
          object.storage_key AS "storageKey"
        FROM media_assets AS asset
        INNER JOIN media_asset_storage_objects AS object
          ON object.media_asset_id = asset.id
          AND object.role = 'ORIGINAL_UPLOAD'
          AND object.revoked_at IS NULL
        WHERE asset.id = ${assetId}
      `;
      if (source === undefined) return null;
      return Object.freeze({
        declaredContentType: source.declaredContentType,
        id: source.id,
        kind: source.kind,
        originalStorageObject: Object.freeze({
          area: source.storageArea,
          key: source.storageKey as DocumentProcessingAssetSource["originalStorageObject"]["key"],
        }),
        status: source.status,
      });
    },

    async completeImageProcessing(
      input: CompleteImageProcessingInput,
    ): Promise<ImageProcessingCompletionResult> {
      if (!assetIdPattern.test(input.assetId)) {
        return Object.freeze({ transition: "NOT_PROCESSING" as const });
      }
      assertImageCompletionInput(input);

      return sql.begin(async (transaction) => {
        const [asset] = await transaction<LockedMediaAssetRow[]>`
          SELECT id, kind, status
          FROM media_assets
          WHERE id = ${input.assetId}
          FOR UPDATE
        `;
        if (asset === undefined || asset.kind !== "IMAGE") {
          return Object.freeze({ transition: "NOT_PROCESSING" as const });
        }
        if (asset.status === "READY") {
          return Object.freeze({ transition: "ALREADY_READY" as const });
        }
        if (asset.status !== "PROCESSING") {
          return Object.freeze({ transition: "NOT_PROCESSING" as const });
        }

        for (const derivative of input.derivatives) {
          await transaction`
            INSERT INTO media_asset_storage_objects (
              media_asset_id,
              role,
              storage_area,
              storage_key,
              content_type,
              byte_size,
              content_sha256
            ) VALUES (
              ${input.assetId},
              ${derivative.role},
              ${derivative.storageObject.area},
              ${derivative.storageObject.key},
              ${derivative.contentType},
              ${derivative.byteSize},
              ${derivative.contentSha256}
            )
          `;
        }

        await transaction`
          UPDATE media_assets
          SET
            status = 'READY',
            status_changed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            ready_at = CURRENT_TIMESTAMP,
            captured_at = ${input.capturedAt},
            canonical_width = ${input.canonicalWidth},
            canonical_height = ${input.canonicalHeight}
          WHERE id = ${input.assetId}
            AND status = 'PROCESSING'
            AND kind = 'IMAGE'
        `;
        return Object.freeze({ transition: "UPDATED" as const });
      });
    },

    async completeDocumentProcessing(
      input: CompleteDocumentProcessingInput,
    ): Promise<DocumentProcessingCompletionResult> {
      if (!assetIdPattern.test(input.assetId)) {
        return Object.freeze({ transition: "NOT_PROCESSING" as const });
      }
      assertDocumentCompletionInput(input);

      return sql.begin(async (transaction) => {
        const [asset] = await transaction<LockedMediaAssetRow[]>`
          SELECT id, kind, status
          FROM media_assets
          WHERE id = ${input.assetId}
          FOR UPDATE
        `;
        if (asset === undefined || asset.kind !== "DOCUMENT") {
          return Object.freeze({ transition: "NOT_PROCESSING" as const });
        }
        if (asset.status === "READY") {
          return Object.freeze({ transition: "ALREADY_READY" as const });
        }
        if (asset.status !== "PROCESSING") {
          return Object.freeze({ transition: "NOT_PROCESSING" as const });
        }

        await transaction`
          INSERT INTO media_asset_storage_objects (
            media_asset_id,
            role,
            storage_area,
            storage_key,
            content_type,
            byte_size,
            content_sha256
          ) VALUES (
            ${input.assetId},
            'CANONICAL',
            ${input.canonical.storageObject.area},
            ${input.canonical.storageObject.key},
            ${input.canonical.contentType},
            ${input.canonical.byteSize},
            ${input.canonical.contentSha256}
          )
        `;

        await transaction`
          UPDATE media_assets
          SET
            status = 'READY',
            status_changed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            ready_at = CURRENT_TIMESTAMP,
            document_page_count = ${input.pageCount},
            document_content_sha256 = ${input.canonical.contentSha256},
            malware_scan_verdict = ${input.scan.verdict},
            malware_scanned_at = ${input.scan.scannedAt},
            malware_scanner_engine = ${input.scan.engine},
            malware_scanner_engine_version = ${input.scan.engineVersion},
            malware_signature_version = ${input.scan.signatureVersion}
          WHERE id = ${input.assetId}
            AND status = 'PROCESSING'
            AND kind = 'DOCUMENT'
        `;
        return Object.freeze({ transition: "UPDATED" as const });
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
          AND kind = 'DOCUMENT'
          AND EXISTS (
            SELECT 1
            FROM media_asset_storage_objects AS object
            WHERE object.media_asset_id = media_assets.id
              AND object.role = 'CANONICAL'
              AND object.revoked_at IS NULL
          )
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

function assertImageCompletionInput(input: CompleteImageProcessingInput): void {
  if (
    !Number.isSafeInteger(input.canonicalWidth) ||
    !Number.isSafeInteger(input.canonicalHeight) ||
    input.canonicalWidth < 1 ||
    input.canonicalHeight < 1 ||
    input.canonicalWidth > 2_560 ||
    input.canonicalHeight > 2_560
  ) {
    throw new Error("Canonical image dimensions are invalid.");
  }
  if (
    input.capturedAt !== null &&
    !Number.isFinite(input.capturedAt.valueOf())
  ) {
    throw new Error("Captured-at metadata must be a valid timestamp.");
  }
  const roles = new Set(input.derivatives.map((item) => item.role));
  if (
    input.derivatives.length !== 2 ||
    !roles.has("CANONICAL") ||
    !roles.has("THUMBNAIL")
  ) {
    throw new Error("Canonical and thumbnail derivatives are required.");
  }
  for (const derivative of input.derivatives) {
    if (
      derivative.storageObject.area !== "private" ||
      derivative.contentType !== "image/webp" ||
      !Number.isSafeInteger(derivative.byteSize) ||
      derivative.byteSize < 1 ||
      derivative.byteSize > 26_214_400 ||
      !/^[0-9a-f]{64}$/u.test(derivative.contentSha256)
    ) {
      throw new Error("Image derivative metadata is invalid.");
    }
  }
}

function assertDocumentCompletionInput(
  input: CompleteDocumentProcessingInput,
): void {
  const boundedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
  if (
    input.canonical.role !== "CANONICAL" ||
    input.canonical.storageObject.area !== "private" ||
    input.canonical.contentType !== "application/pdf" ||
    !Number.isSafeInteger(input.canonical.byteSize) ||
    input.canonical.byteSize < 1 ||
    input.canonical.byteSize > 26_214_400 ||
    !/^[0-9a-f]{64}$/u.test(input.canonical.contentSha256) ||
    !Number.isSafeInteger(input.pageCount) ||
    input.pageCount < 1 ||
    input.pageCount > 200 ||
    input.scan.assurance !== "ACTIVE" ||
    input.scan.verdict !== "CLEAN" ||
    input.scan.contentSha256 !== input.canonical.contentSha256 ||
    !boundedIdentifierPattern.test(input.scan.engine) ||
    !boundedIdentifierPattern.test(input.scan.engineVersion) ||
    !boundedIdentifierPattern.test(input.scan.signatureVersion) ||
    !Number.isFinite(input.scan.scannedAt.valueOf())
  ) {
    throw new Error("Document completion evidence is invalid.");
  }
}
