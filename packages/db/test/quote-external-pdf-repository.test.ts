import type { PrivateMediaDeliverySnapshot } from "@portal/media";
import type { QuoteId, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createExternalPdfQuoteRepository,
  createQuoteDocumentMediaAccessResolver,
  createQuoteDocumentUploadAuthorization,
} from "../src/quote-external-pdf-repository.js";

const actorUserId = "98600000-0000-4000-8000-000000000001" as UserId;
const quoteId = "98600000-0000-4000-8000-000000000002" as QuoteId;
const assetId = "98600000-0000-4000-8000-000000000003";

describe("external PDF Quote repository", () => {
  it("reads only after ACTIVE participant and Quote locks", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [{ id: quoteId }],
      [contentRow()],
    ]);
    await expect(
      createExternalPdfQuoteRepository(fixture.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toMatchObject({
      pdfAssetId: assetId,
      pdfDownloadPath: `/v1/media/${assetId}/download`,
      providerConfirmedSummaryMatchesPdf: true,
    });
    expect(fixture.statements[0]).toContain("account_state = 'ACTIVE'");
    expect(fixture.statements[1]).toContain("head.state <> 'DRAFT'");
    expect(fixture.statements[2]).not.toMatch(/storage|sha256|malware/u);
  });

  it("fails closed before content for inactive actors", async () => {
    const fixture = scriptedSql([[]]);
    await expect(
      createExternalPdfQuoteRepository(fixture.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toBeNull();
    expect(fixture.statements).toHaveLength(1);
  });

  it("fails closed on corrupt DB-authored confirmation timestamps", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [{ id: quoteId }],
      [{ ...contentRow(), confirmedAt: new Date(Number.NaN) }],
    ]);
    await expect(
      createExternalPdfQuoteRepository(fixture.sql).readOwned({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).rejects.toThrow(/Corrupt external PDF Quote projection/u);
  });

  it("authorizes uploads in core lock order and allows another DRAFT PDF", async () => {
    const fixture = scriptedSql([
      [{ id: actorUserId }],
      [
        {
          conversationId: "98600000-0000-4000-8000-000000000004",
          invitationId: "98600000-0000-4000-8000-000000000005",
        },
      ],
      [{ id: "invitation" }],
      [{ id: "conversation" }],
      [{ id: quoteId }],
      [{ quoteId }],
    ]);
    await expect(
      createQuoteDocumentUploadAuthorization(fixture.sql).prepareUpload({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toMatchObject({
      purpose: "QUOTE_DOCUMENT",
      status: "AUTHORIZED",
      provenance: {
        entityId: quoteId,
        entityRevision: 1,
        entityType: "QUOTE_REVISION",
      },
    });
    const joined = fixture.statements.join("\n");
    expect(joined).toContain("revision.authoring_mode = 'EXTERNAL_PDF'");
    expect(joined.indexOf("FROM job_invitations")).toBeLessThan(
      joined.indexOf("FROM conversations"),
    );
    expect(joined.indexOf("FROM conversations")).toBeLessThan(
      joined.indexOf("FROM quotes WHERE"),
    );
    expect(joined).not.toContain("quote_external_pdf_documents");
  });

  it("denies the R3-017 upload seam for a non-external Quote revision", async () => {
    const fixture = scriptedSql([[{ id: actorUserId }], []]);
    await expect(
      createQuoteDocumentUploadAuthorization(fixture.sql).prepareUpload({
        actorUserId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toEqual({ status: "UPLOAD_UNAVAILABLE" });
    expect(fixture.statements.join("\n")).toContain(
      "revision.authoring_mode = 'EXTERNAL_PDF'",
    );
  });

  it("throws for an unbound asset instead of returning trusted empty access", async () => {
    const fixture = scriptedSql([[]]);
    await expect(
      createQuoteDocumentMediaAccessResolver(
        fixture.sql,
      ).resolvePrivateMediaAccess(snapshot()),
    ).rejects.toThrow(/Unbound Quote document/u);
  });

  it("binds customer delivery to the currently selected submitted PDF", async () => {
    const fixture = scriptedSql([
      [
        {
          actorStateChangedAt: new Date("2026-09-15T10:00:00Z"),
          contentRevision: 2,
          participantRole: "CUSTOMER",
          quoteId,
          quoteRevision: 1,
          selectedPdfAssetId: assetId,
          state: "SUBMITTED",
          stateRevision: 2,
        },
      ],
    ]);
    await expect(
      createQuoteDocumentMediaAccessResolver(
        fixture.sql,
      ).resolvePrivateMediaAccess(snapshot()),
    ).resolves.toMatchObject({ grants: ["QUOTE_REQUEST_CUSTOMER"] });
    expect(fixture.statements[0]).toContain(
      "JOIN current_quote_external_pdf_content content",
    );
    expect(fixture.statements[0]).toContain(
      "content.pdf_media_asset_id = asset.id",
    );
  });

  it("fails closed on a corrupt delivery role", async () => {
    const fixture = scriptedSql([
      [
        {
          actorStateChangedAt: new Date("2026-09-15T10:00:00Z"),
          contentRevision: 2,
          participantRole: "ADMIN",
          quoteId,
          quoteRevision: 1,
          selectedPdfAssetId: assetId,
          state: "SUBMITTED",
          stateRevision: 2,
        },
      ],
    ]);
    await expect(
      createQuoteDocumentMediaAccessResolver(
        fixture.sql,
      ).resolvePrivateMediaAccess(snapshot()),
    ).rejects.toThrow(/Unbound Quote document/u);
  });

  it("maps a submit-won save to READ_ONLY", async () => {
    const fixture = scriptedSql([
      [],
      [{ id: actorUserId }],
      [
        {
          conversationId: "98600000-0000-4000-8000-000000000004",
          invitationId: "98600000-0000-4000-8000-000000000005",
        },
      ],
      [{ id: "invitation" }],
      [{ id: "conversation" }],
      [{ id: quoteId }],
      [],
      new Error("editable EXTERNAL_PDF Quote draft required"),
    ]);
    await expect(
      createExternalPdfQuoteRepository(fixture.sql).saveDraft(saveInput()),
    ).resolves.toEqual({ status: "READ_ONLY" });
  });
});

function saveInput() {
  return {
    actorUserId,
    commandId: "98600000-0000-4000-8000-000000000006",
    envelope: {
      currency: "EUR" as const,
      priceMode: "FIXED" as const,
      providerConfirmedSummaryMatchesPdf: true as const,
      totalAmountCents: 150_000,
      vatStatus: "VAT_INCLUDED" as const,
    },
    expectedContentRevision: 0,
    pdfAssetId: assetId,
    quoteId,
    quoteRevision: 1,
  };
}

function contentRow() {
  return {
    confirmedAt: new Date("2026-09-15T10:00:00Z"),
    contentRevision: 1,
    currency: "EUR",
    depositAmountCents: null,
    depositMode: null,
    depositPercentageBasisPoints: null,
    estimatedDurationDays: null,
    estimatedStartOn: null,
    materialResponsibility: null,
    pdfAssetId: assetId,
    priceMode: "FIXED",
    providerConfirmedSummaryMatchesPdf: true,
    quoteId,
    quoteRevision: 1,
    rangeMaximumCents: null,
    rangeMinimumCents: null,
    savedAt: new Date("2026-09-15T10:00:00Z"),
    totalAmountCents: "150000",
    validUntil: null,
    vatStatus: "VAT_INCLUDED",
  };
}

function snapshot(): PrivateMediaDeliverySnapshot {
  return {
    actor: { accountState: "ACTIVE", userId: actorUserId },
    asset: {
      id: assetId,
      ownerUserId: actorUserId,
      provenanceEntityId: quoteId,
      provenanceEntityRevision: 1,
      provenanceEntityType: "QUOTE_REVISION",
      purpose: "QUOTE_DOCUMENT",
      status: "READY",
      updatedAt: new Date("2026-09-15T10:00:00Z"),
    },
    object: {
      contentType: "application/pdf",
      createdAt: new Date("2026-09-15T10:00:00Z"),
      id: "98600000-0000-4000-8000-000000000007",
      revokedAt: null,
      role: "CANONICAL",
      storageObject: {
        area: "private",
        key: "private/2026/09/98600000-0000-4000-8000-000000000008" as never,
      },
    },
  };
}

function scriptedSql(results: Array<unknown[] | Error>) {
  const statements: string[] = [];
  const query = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    const result = results.shift() ?? [];
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  }) as unknown as Sql;
  Object.assign(query, {
    begin: (callback: (transaction: Sql) => Promise<unknown>) =>
      callback(query),
    savepoint: (callback: (transaction: Sql) => Promise<unknown>) =>
      callback(query),
  });
  return { sql: query, statements };
}
