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
    expect(repository.match(/AND status = 'PROCESSING'/gu)).toHaveLength(2);
    expect(repository).not.toMatch(/\$\{[^}]*originalFilename/gu);
  });
});
