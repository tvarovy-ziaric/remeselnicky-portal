import { sql } from "drizzle-orm";
import {
  check,
  char,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./user.js";

export const MEDIA_ASSET_STATUS_VALUES = [
  "PROCESSING",
  "READY",
  "REJECTED",
] as const;
export const MEDIA_KIND_VALUES = ["IMAGE", "DOCUMENT"] as const;
export const MEDIA_UPLOAD_PURPOSE_VALUES = [
  "PROFILE_IMAGE",
  "PORTFOLIO_IMAGE",
  "JOB_REQUEST_IMAGE",
  "JOB_IMAGE",
  "JOB_DOCUMENT",
  "CHAT_IMAGE",
  "CHAT_DOCUMENT",
  "CREDENTIAL_DOCUMENT",
  "QUOTE_DOCUMENT",
  "CHANGE_ORDER_DOCUMENT",
  "DISPUTE_EVIDENCE",
] as const;
export const MEDIA_PROVENANCE_ENTITY_TYPE_VALUES = [
  "USER_PROFILE",
  "PORTFOLIO_PROJECT",
  "JOB_REQUEST",
  "JOB",
  "JOB_PARTICIPANT",
  "CONVERSATION_MESSAGE",
  "CREDENTIAL",
  "QUOTE_REVISION",
  "CHANGE_ORDER_REVISION",
  "DISPUTE_CASE",
] as const;
export const MEDIA_STORAGE_AREA_VALUES = [
  "private",
  "public-derivative",
] as const;
export const MEDIA_STORAGE_ROLE_VALUES = [
  "ORIGINAL_UPLOAD",
  "CANONICAL",
  "THUMBNAIL",
  "DETAIL",
] as const;

export const mediaAssetStatusEnum = pgEnum(
  "media_asset_status",
  MEDIA_ASSET_STATUS_VALUES,
);
export const mediaKindEnum = pgEnum("media_kind", MEDIA_KIND_VALUES);
export const mediaUploadPurposeEnum = pgEnum(
  "media_upload_purpose",
  MEDIA_UPLOAD_PURPOSE_VALUES,
);
export const mediaProvenanceEntityTypeEnum = pgEnum(
  "media_provenance_entity_type",
  MEDIA_PROVENANCE_ENTITY_TYPE_VALUES,
);
export const mediaStorageAreaEnum = pgEnum(
  "media_storage_area",
  MEDIA_STORAGE_AREA_VALUES,
);
export const mediaStorageRoleEnum = pgEnum(
  "media_storage_role",
  MEDIA_STORAGE_ROLE_VALUES,
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: mediaKindEnum("kind").notNull(),
    purpose: mediaUploadPurposeEnum("purpose").notNull(),
    status: mediaAssetStatusEnum("status").notNull().default("PROCESSING"),
    declaredContentType: text("declared_content_type").notNull(),
    displayFilename: text("display_filename"),
    byteSize: integer("byte_size").notNull(),
    provenanceEntityType: mediaProvenanceEntityTypeEnum(
      "provenance_entity_type",
    ),
    provenanceEntityId: uuid("provenance_entity_id"),
    provenanceEntityRevision: integer("provenance_entity_revision"),
    rejectionCode: text("rejection_code"),
    capturedAt: timestamp("captured_at", { mode: "date", withTimezone: true }),
    canonicalWidth: integer("canonical_width"),
    canonicalHeight: integer("canonical_height"),
    documentPageCount: integer("document_page_count"),
    documentContentSha256: char("document_content_sha256", { length: 64 }),
    malwareScanVerdict: text("malware_scan_verdict"),
    malwareScannedAt: timestamp("malware_scanned_at", {
      mode: "date",
      withTimezone: true,
    }),
    malwareScannerEngine: text("malware_scanner_engine"),
    malwareScannerEngineVersion: text("malware_scanner_engine_version"),
    malwareSignatureVersion: text("malware_signature_version"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    statusChangedAt: timestamp("status_changed_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    readyAt: timestamp("ready_at", { mode: "date", withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("media_assets_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    index("media_assets_uploader_created_idx").on(
      table.uploadedByUserId,
      table.createdAt,
    ),
    index("media_assets_processing_idx").on(table.createdAt),
    index("media_assets_provenance_idx").on(
      table.provenanceEntityType,
      table.provenanceEntityId,
    ),
    check(
      "media_assets_byte_size_bounded",
      sql`${table.byteSize} BETWEEN 1 AND 26214400`,
    ),
  ],
);

export const mediaAssetStorageObjects = pgTable(
  "media_asset_storage_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    role: mediaStorageRoleEnum("role").notNull(),
    storageArea: mediaStorageAreaEnum("storage_area").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentSha256: char("content_sha256", { length: 64 }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("media_asset_storage_objects_key_unique").on(table.storageKey),
    unique("media_asset_storage_objects_role_unique").on(
      table.mediaAssetId,
      table.role,
    ),
    index("media_asset_storage_objects_asset_idx").on(
      table.mediaAssetId,
      table.createdAt,
    ),
  ],
);

export type MediaAssetRecord = typeof mediaAssets.$inferSelect;
export type NewMediaAssetRecord = typeof mediaAssets.$inferInsert;
export type MediaAssetStorageObjectRecord =
  typeof mediaAssetStorageObjects.$inferSelect;
export type NewMediaAssetStorageObjectRecord =
  typeof mediaAssetStorageObjects.$inferInsert;
