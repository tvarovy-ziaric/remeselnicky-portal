import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MEDIA_ASSET_STATUS_VALUES,
  MEDIA_KIND_VALUES,
  MEDIA_PROVENANCE_ENTITY_TYPE_VALUES,
  MEDIA_STORAGE_AREA_VALUES,
  MEDIA_STORAGE_ROLE_VALUES,
  MEDIA_UPLOAD_PURPOSE_VALUES,
  mediaAssetStorageObjects,
  mediaAssets,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0003_media_assets.sql", import.meta.url),
  ),
  "utf8",
);
const repository = readFileSync(
  fileURLToPath(new URL("../src/media-repository.ts", import.meta.url)),
  "utf8",
);
const imageMigration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0005_image_canonicalization.sql", import.meta.url),
  ),
  "utf8",
);
const documentMigration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0008_document_validation.sql", import.meta.url),
  ),
  "utf8",
);

describe("media asset schema", () => {
  it("exports the locked status, type, purpose and provenance vocabulary", () => {
    expect(MEDIA_ASSET_STATUS_VALUES).toEqual([
      "PROCESSING",
      "READY",
      "REJECTED",
    ]);
    expect(MEDIA_KIND_VALUES).toEqual(["IMAGE", "DOCUMENT"]);
    expect(MEDIA_UPLOAD_PURPOSE_VALUES).toContain("PORTFOLIO_IMAGE");
    expect(MEDIA_UPLOAD_PURPOSE_VALUES).toContain("CHAT_DOCUMENT");
    expect(MEDIA_UPLOAD_PURPOSE_VALUES).toContain("JOB_DOCUMENT");
    expect(MEDIA_PROVENANCE_ENTITY_TYPE_VALUES).toContain("JOB_REQUEST");
    expect(MEDIA_PROVENANCE_ENTITY_TYPE_VALUES).toContain("JOB_PARTICIPANT");
    expect(MEDIA_PROVENANCE_ENTITY_TYPE_VALUES).toContain("QUOTE_REVISION");
    expect(MEDIA_STORAGE_AREA_VALUES).toEqual(["private", "public-derivative"]);
    expect(MEDIA_STORAGE_ROLE_VALUES).toEqual([
      "ORIGINAL_UPLOAD",
      "CANONICAL",
      "THUMBNAIL",
      "DETAIL",
    ]);
    expect(mediaAssets.id).toBeDefined();
    expect(mediaAssetStorageObjects.storageKey).toBeDefined();
  });

  it("enforces centralized status, provenance, size and storage boundaries", () => {
    expect(migration).toMatch(/media_assets_status_fields_consistent/u);
    expect(migration).toMatch(/media_assets_provenance_complete/u);
    expect(migration).toMatch(/byte_size BETWEEN 1 AND 26214400/u);
    expect(migration).toMatch(/media_asset_storage_objects_key_matches_area/u);
    expect(migration).toMatch(/ON DELETE RESTRICT/gu);
    expect(migration).not.toMatch(/\b(?:BEGIN|COMMIT)\b/iu);
  });

  it("creates metadata and the private original reference atomically", () => {
    expect(repository).toMatch(/sql\.begin/gu);
    expect(repository).toMatch(/'ORIGINAL_UPLOAD'/u);
    expect(repository).toMatch(/input\.storageObject\.area !== "private"/u);
    expect(repository).toMatch(/recordMediaProcessingSucceeded/u);
    expect(repository).toMatch(/recordMediaProcessingRejected/u);
    expect(
      repository.match(/AND status = 'PROCESSING'/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
    expect(repository).toMatch(/completeImageProcessing/u);
    expect(repository).toMatch(/completeDocumentProcessing/u);
    expect(repository).toMatch(/findDocumentProcessingSource/u);
    expect(repository).toMatch(/FOR UPDATE/u);
    expect(repository).toMatch(/'CANONICAL'/u);
    expect(repository).toMatch(/"THUMBNAIL"/u);
    expect(repository).toMatch(/kind = 'DOCUMENT'/u);
    expect(repository).not.toMatch(/\$\{[^}]*originalFilename/gu);
  });

  it("requires bounded canonical dimensions before an image becomes READY", () => {
    expect(imageMigration).toMatch(/media_assets_image_dimensions_consistent/u);
    expect(imageMigration).toMatch(/canonical_width BETWEEN 1 AND 2560/u);
    expect(imageMigration).toMatch(/media_assets_captured_at_consistent/u);
    expect(imageMigration).toMatch(
      /media_asset_storage_objects_private_source_and_canonical/u,
    );
    expect(imageMigration).not.toMatch(/\b(?:BEGIN|COMMIT)\b/iu);
  });

  it("requires clean hash-bound scan evidence and a private canonical PDF before READY", () => {
    expect(documentMigration).toMatch(
      /media_assets_ready_document_evidence_complete/u,
    );
    expect(documentMigration).toMatch(/malware_scan_verdict = 'CLEAN'/u);
    expect(documentMigration).toMatch(
      /media_assets_ready_document_canonical_guard/u,
    );
    expect(documentMigration).toMatch(
      /object\.content_sha256 = NEW\.document_content_sha256/u,
    );
    expect(documentMigration).toMatch(/object\.storage_area = 'private'/u);
    expect(documentMigration).not.toMatch(/^\s*BEGIN\s*;/iu);
    expect(documentMigration).not.toMatch(/COMMIT\s*;\s*$/iu);
  });
});
