import type {
  ConversationId,
  JobInvitationId,
  JobRequestId,
  Quote,
  QuoteId,
  QuotePersistence,
  StructuredQuotePersistence,
  ExternalPdfQuotePersistence,
  UserId,
} from "@portal/domain";
import type { QuoteDocumentUploadService } from "@portal/media";
import type { createQuoteSupportingDocumentRepository } from "@portal/db";
import Fastify, {
  type FastifyInstance,
  type onRequestHookHandler,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUOTE_AUTHORING_PATHS,
  registerQuoteAuthoringRoutes,
} from "./routes.js";

const actorUserId = "8a000000-0000-4000-8000-000000000001" as UserId;
const quoteId = "8a000000-0000-4000-8000-000000000002" as QuoteId;
const conversationId = "8a000000-0000-4000-8000-000000000003" as ConversationId;
const invitationId = "8a000000-0000-4000-8000-000000000004" as JobInvitationId;
const jobRequestId = "8a000000-0000-4000-8000-000000000005" as JobRequestId;
const commandId = "8a000000-0000-4000-8000-000000000006";
const pdfAssetId = "8a000000-0000-4000-8000-000000000007";
const now = new Date("2026-09-15T12:00:00.000Z");
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Quote authoring routes", () => {
  it("binds and privately reads only explicit supporting PDFs", async () => {
    const fixture = build();
    fixture.supportingDocumentUploads.upload.mockResolvedValue({
      assetId: pdfAssetId,
      status: "PROCESSING",
    });
    const upload = await fixture.app.inject({
      headers: { "content-type": "application/pdf" },
      method: "POST",
      payload: Buffer.from("%PDF-1.7\nsynthetic"),
      url: revisionPath(QUOTE_AUTHORING_PATHS.supportingDocumentUpload),
    });
    expect(upload.statusCode).toBe(202);
    expect(fixture.supportingDocumentUploads.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteId,
        quoteRevision: 1,
      }),
    );
    fixture.supportingDocuments.attach.mockResolvedValue({
      document: {
        attachedAt: now,
        downloadPath: `/v1/media/${pdfAssetId}/download`,
        mediaAssetId: pdfAssetId,
      },
      status: "ATTACHED",
    });
    const attached = await fixture.app.inject({
      method: "POST",
      payload: { commandId, mediaAssetId: pdfAssetId },
      url: revisionPath(QUOTE_AUTHORING_PATHS.supportingDocuments),
    });
    expect(attached.statusCode).toBe(201);
    expect(fixture.supportingDocuments.attach).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      mediaAssetId: pdfAssetId,
      quoteId,
      quoteRevision: 1,
    });
    expect(attached.body).not.toMatch(/storage|hash|scanner/iu);
    fixture.supportingDocuments.readOwned.mockResolvedValue([
      {
        attachedAt: now,
        downloadPath: `/v1/media/${pdfAssetId}/download`,
        mediaAssetId: pdfAssetId,
      },
    ]);
    const listed = await fixture.app.inject({
      method: "GET",
      url: revisionPath(QUOTE_AUTHORING_PATHS.supportingDocuments),
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toEqual({
      documents: [
        {
          attachedAt: now.toISOString(),
          downloadPath: `/v1/media/${pdfAssetId}/download`,
          mediaAssetId: pdfAssetId,
        },
      ],
    });
    expect(listed.headers["cache-control"]).toBe("private, no-store");
    expect(fixture.evaluate).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(fixture.evaluate).toHaveBeenCalledWith(expect.anything(), "QUOTING");
    fixture.supportingDocuments.remove.mockResolvedValue({
      status: "REMOVED",
    });
    const removed = await fixture.app.inject({
      method: "POST",
      payload: { commandId },
      url: path(QUOTE_AUTHORING_PATHS.supportingDocumentRemoval, {
        mediaAssetId: pdfAssetId,
        quoteId,
        quoteRevision: "1",
      }),
    });
    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(removed.body)).toEqual({ status: "REMOVED" });
    expect(fixture.supportingDocuments.remove).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      mediaAssetId: pdfAssetId,
      quoteId,
      quoteRevision: 1,
    });
  });

  it("keeps supporting-document operations behind session and exact intent", async () => {
    const fixture = build("AUTHENTICATION_REQUIRED");
    const unauthenticated = await fixture.app.inject({
      method: "POST",
      payload: { commandId, mediaAssetId: pdfAssetId },
      url: revisionPath(QUOTE_AUTHORING_PATHS.supportingDocuments),
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(fixture.supportingDocuments.attach).not.toHaveBeenCalled();
    const malformed = await fixture.app.inject({
      method: "POST",
      payload: { commandId, mediaAssetId: "not-a-uuid" },
      url: revisionPath(QUOTE_AUTHORING_PATHS.supportingDocuments),
    });
    expect(malformed.statusCode).toBe(400);
    expect(fixture.supportingDocuments.attach).not.toHaveBeenCalled();
  });

  it("uploads an external Quote PDF through the exact provider boundary", async () => {
    const fixture = build();
    fixture.documentUploads.upload.mockResolvedValue({
      assetId: pdfAssetId,
      status: "PROCESSING",
    });
    const response = await fixture.app.inject({
      headers: { "content-type": "application/pdf" },
      method: "POST",
      payload: Buffer.from("%PDF-1.7\nsynthetic"),
      url: revisionPath(QUOTE_AUTHORING_PATHS.externalDocument),
    });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body) as unknown).toEqual({
      assetId: pdfAssetId,
      status: "PROCESSING",
    });
    expect(fixture.documentUploads.upload).toHaveBeenCalledOnce();
    const upload = fixture.documentUploads.upload.mock.calls[0]?.[0];
    expect(upload?.actor).toMatchObject({
      accountState: "ACTIVE",
      kind: "AUTHENTICATED",
      userId: actorUserId,
    });
    expect(Buffer.isBuffer(upload?.body)).toBe(true);
    expect(upload).toMatchObject({
      declaredContentType: "application/pdf",
      quoteId,
      quoteRevision: 1,
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).not.toMatch(/filename|storage|hash|scanner/iu);
  });

  it("creates and reads an allowlisted no-store Quote using the session actor", async () => {
    const fixture = build();
    fixture.core.createDraft.mockResolvedValue({ status: "APPLIED", quote });
    fixture.core.readOwnedByInvitation.mockResolvedValue(quote);
    const created = await fixture.app.inject({
      method: "POST",
      payload: {
        authoringMode: "PLATFORM_STRUCTURED",
        commandId,
        requestContentRevision: 3,
        requestVisibleVersion: 2,
      },
      url: path(QUOTE_AUTHORING_PATHS.create, { conversationId }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("private, no-store");
    expect(created.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(fixture.csrf).toHaveBeenCalledOnce();
    expect(fixture.core.createDraft).toHaveBeenCalledWith({
      actorUserId,
      authoringMode: "PLATFORM_STRUCTURED",
      commandId,
      conversationId,
      requestContentRevision: 3,
      requestVisibleVersion: 2,
    });
    expect(created.body).not.toMatch(
      /ownerUserId|storageKey|sha256|scanner|customerProfileId/iu,
    );

    const read = await fixture.app.inject({
      method: "GET",
      url: path(QUOTE_AUTHORING_PATHS.byInvitation, { invitationId }),
    });
    expect(read.statusCode).toBe(200);
    expect(fixture.core.readOwnedByInvitation).toHaveBeenCalledWith({
      actorUserId,
      invitationId,
    });
  });

  it("normalizes structured and external dates before persistence", async () => {
    const fixture = build();
    fixture.structured.saveDraft.mockImplementation((input) =>
      Promise.resolve({
        content: {
          changedAt: now,
          components: {
            labor: { amountCents: null, description: null },
            material: { amountCents: null, description: null },
            other: { amountCents: null, description: null },
            transport: { amountCents: null, description: null },
          },
          conditionalOnInspection: false,
          currency: "EUR",
          contentRevision: 1,
          depositAmountCents: null,
          depositMode: null,
          depositNotes: null,
          depositPercentageBasisPoints: null,
          estimatedDurationDays: null,
          estimatedStartOn: null,
          excludedScope: [],
          includedScope: [],
          inspectionConditions: null,
          materialResponsibility: "PROVIDER",
          priceBasis: input.content.priceBasis,
          priceMode: "FIXED",
          providerNotes: null,
          quoteId,
          quoteRevision: 1,
          rangeMaximumCents: null,
          rangeMinimumCents: null,
          summary: input.content.summary,
          title: input.content.title,
          totalAmountCents: 125_000,
          validUntil: input.content.validUntil ?? null,
          vatStatus: "VAT_INCLUDED",
          warrantyInformation: null,
        },
        status: "SAVED",
      }),
    );
    const structured = await fixture.app.inject({
      method: "POST",
      payload: {
        commandId,
        content: {
          components: {},
          conditionalOnInspection: false,
          currency: "EUR",
          materialResponsibility: "PROVIDER",
          priceBasis: "Celková cena za dohodnutý rozsah.",
          priceMode: "FIXED",
          summary: "Realizácia podľa zadania.",
          title: "Cenová ponuka",
          totalAmountCents: 125_000,
          validUntil: "2026-10-15T12:00:00.000Z",
          vatStatus: "VAT_INCLUDED",
        },
        expectedContentRevision: 0,
      },
      url: revisionPath(QUOTE_AUTHORING_PATHS.structured),
    });
    expect(structured.statusCode).toBe(200);
    expect(
      fixture.structured.saveDraft.mock.calls[0]?.[0].content.validUntil,
    ).toEqual(new Date("2026-10-15T12:00:00.000Z"));

    fixture.externalPdf.saveDraft.mockImplementation((input) =>
      Promise.resolve({
        revision: {
          confirmedAt: now,
          contentRevision: 1,
          currency: "EUR",
          depositAmountCents: null,
          depositMode: null,
          depositPercentageBasisPoints: null,
          estimatedDurationDays: null,
          estimatedStartOn: null,
          materialResponsibility: null,
          pdfAssetId,
          pdfDownloadPath: `/v1/media/${pdfAssetId}/download`,
          priceMode: "FIXED",
          providerConfirmedSummaryMatchesPdf: true,
          quoteId,
          quoteRevision: 1,
          rangeMaximumCents: null,
          rangeMinimumCents: null,
          savedAt: now,
          totalAmountCents: 125_000,
          validUntil: input.envelope.validUntil ?? null,
          vatStatus: "VAT_INCLUDED",
        },
        status: "SAVED",
      }),
    );
    const external = await fixture.app.inject({
      method: "POST",
      payload: {
        commandId,
        envelope: {
          currency: "EUR",
          priceMode: "FIXED",
          providerConfirmedSummaryMatchesPdf: true,
          totalAmountCents: 125_000,
          validUntil: "2026-10-15T12:00:00.000Z",
          vatStatus: "VAT_INCLUDED",
        },
        expectedContentRevision: 0,
        pdfAssetId,
      },
      url: revisionPath(QUOTE_AUTHORING_PATHS.external),
    });
    expect(external.statusCode).toBe(200);
    expect(
      fixture.externalPdf.saveDraft.mock.calls[0]?.[0].envelope.validUntil,
    ).toEqual(new Date("2026-10-15T12:00:00.000Z"));
    expect(external.body).not.toMatch(/storageKey|sha256|scanEvidence/iu);
  });

  it("blocks inactive actors, validates shapes and hides persistence errors", async () => {
    const anonymous = build("AUTHENTICATION_REQUIRED");
    expect(
      (
        await anonymous.app.inject({
          method: "GET",
          url: path(QUOTE_AUTHORING_PATHS.quote, { quoteId }),
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.core.readOwned).not.toHaveBeenCalled();

    const fixture = build();
    const malformed = await fixture.app.inject({
      method: "POST",
      payload: {
        authoringMode: "UNKNOWN_MODE",
        commandId,
        requestContentRevision: 3,
        requestVisibleVersion: 2,
      },
      url: path(QUOTE_AUTHORING_PATHS.create, { conversationId }),
    });
    expect(malformed.statusCode).toBe(400);
    expect(fixture.core.createDraft).not.toHaveBeenCalled();

    fixture.core.readOwned.mockRejectedValue(new Error("private_storage_key"));
    const failed = await fixture.app.inject({
      method: "GET",
      url: path(QUOTE_AUTHORING_PATHS.quote, { quoteId }),
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toBe('{"code":"TEMPORARILY_UNAVAILABLE"}');
  });
});

const quote: Quote = Object.freeze({
  conversationId,
  createdAt: now,
  currentDraft: Object.freeze({
    authoringMode: "PLATFORM_STRUCTURED",
    changedAt: now,
    createdAt: now,
    rejectionReason: null,
    requestContentRevision: 3,
    requestVisibleVersion: 2,
    revision: 1,
    state: "DRAFT",
    stateRevision: 1,
    submittedAt: null,
  }),
  currentSubmitted: null,
  id: quoteId,
  invitationId,
  jobRequestId,
  participantRole: "CRAFTSMAN",
  revisions: [],
});

function build(
  status:
    "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE",
) {
  const app = Fastify();
  apps.push(app);
  const csrf = vi.fn<onRequestHookHandler>((_request, _reply, done) => done());
  const core = {
    createDraft: vi.fn<QuotePersistence["createDraft"]>(),
    createRevision: vi.fn<QuotePersistence["createRevision"]>(),
    readOwned: vi.fn<QuotePersistence["readOwned"]>(),
    readOwnedByInvitation: vi.fn<QuotePersistence["readOwnedByInvitation"]>(),
    reject: vi.fn<QuotePersistence["reject"]>(),
    submit: vi.fn<QuotePersistence["submit"]>(),
  };
  const structured = {
    readOwned: vi.fn<StructuredQuotePersistence["readOwned"]>(),
    saveDraft: vi.fn<StructuredQuotePersistence["saveDraft"]>(),
  };
  const externalPdf = {
    readOwned: vi.fn<ExternalPdfQuotePersistence["readOwned"]>(),
    saveDraft: vi.fn<ExternalPdfQuotePersistence["saveDraft"]>(),
  };
  const documentUploads = {
    upload: vi.fn<QuoteDocumentUploadService["upload"]>(),
  };
  const supportingDocumentUploads = {
    upload: vi.fn<QuoteDocumentUploadService["upload"]>(),
  };
  const supportingDocuments = {
    attach:
      vi.fn<
        ReturnType<typeof createQuoteSupportingDocumentRepository>["attach"]
      >(),
    readOwned:
      vi.fn<
        ReturnType<typeof createQuoteSupportingDocumentRepository>["readOwned"]
      >(),
    remove:
      vi.fn<
        ReturnType<typeof createQuoteSupportingDocumentRepository>["remove"]
      >(),
  };
  const evaluate = vi.fn(() =>
    Promise.resolve(
      status === "ACTIVE" ? { status, user: { id: actorUserId } } : { status },
    ),
  );
  registerQuoteAuthoringRoutes(app, {
    core,
    csrfProtection: csrf,
    documentUploads,
    externalPdf,
    guard: { evaluate },
    rateLimit: { max: 50, timeWindowMs: 60_000 },
    structured,
    supportingDocumentUploads,
    supportingDocuments,
  });
  return {
    app,
    core,
    csrf,
    documentUploads,
    evaluate,
    externalPdf,
    structured,
    supportingDocumentUploads,
    supportingDocuments,
  };
}

function revisionPath(template: string) {
  return path(template, { quoteId, quoteRevision: "1" });
}

function path(template: string, values: Readonly<Record<string, string>>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`:${key}`, value),
    template,
  );
}
