import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0050_quote_external_pdf.sql", import.meta.url),
  ),
  "utf8",
);

describe("EXTERNAL_PDF Quote migration", () => {
  it("binds one globally unique PDF to an exact immutable Quote revision", () => {
    expect(migration).toContain("pdf_media_asset_id uuid NOT NULL UNIQUE");
    expect(migration).toContain("external PDF Quote history is append-only");
    expect(migration).toContain(
      "PRIMARY KEY (quote_id, quote_revision, pdf_media_asset_id)",
    );
    expect(migration).not.toMatch(/jsonb|ocr|artificial intelligence/iu);
  });
  it("requires exact READY private clean canonical Quote media", () => {
    for (const fragment of [
      "asset.kind <> 'DOCUMENT'",
      "asset.purpose <> 'QUOTE_DOCUMENT'",
      "asset.status <> 'READY'",
      "asset.provenance_entity_type <> 'QUOTE_REVISION'",
      "canonical.storage_area <> 'private'",
      "canonical.revoked_at IS NOT NULL",
      "canonical.content_sha256 IS DISTINCT FROM asset.document_content_sha256",
    ])
      expect(migration).toContain(fragment);
    expect(migration).toContain("quote_document_media_provenance_guard");
    expect(migration).toContain("Quote document media identity is immutable");
    expect(migration).toContain(
      "terminal Quote document media state is immutable",
    );
  });
  it("persists a true provider confirmation with server timestamps", () => {
    expect(migration).toContain(
      "quote_external_pdf_provider_confirmation_true",
    );
    expect(migration).toContain("quote_external_pdf_command_confirmation_true");
    expect(migration).toContain(
      "source.provider_confirmed_summary_matches_pdf",
    );
    expect(migration).toContain("NEW.confirmed_at := source.created_at");
    expect(migration).toContain("NEW.saved_at := source.created_at");
  });
  it("preserves structured eligibility and extends only external PDF", () => {
    expect(migration).toContain("IF target_mode = 'PLATFORM_STRUCTURED'");
    expect(migration).toContain("IF target_mode <> 'EXTERNAL_PDF'");
    expect(migration).toContain("clock_timestamp()");
  });
  it("locks revision, asset and canonical after the Quote-core lock", () => {
    const quote = migration.indexOf("WHERE quote.id = NEW.quote_id FOR UPDATE");
    const head = migration.indexOf("FROM quote_revision_heads head", quote);
    const asset = migration.indexOf("FROM media_assets item", head);
    const canonical = migration.indexOf(
      "FROM media_asset_storage_objects object",
      asset,
    );
    expect(head).toBeGreaterThan(quote);
    expect(asset).toBeGreaterThan(head);
    expect(canonical).toBeGreaterThan(asset);
  });
  it("requires each command to have its exact deferred content effect", () => {
    expect(migration).toContain("quote_external_pdf_command_effect_fk");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
  });
});
