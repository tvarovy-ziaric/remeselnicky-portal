import { describe, expect, it, vi } from "vitest";

import type { QuoteId, UserId } from "../src/index.js";
import {
  StructuredQuoteIdempotencyError,
  createStructuredQuoteService,
  normalizeSaveStructuredQuoteDraftInput,
  normalizeStructuredQuoteContent,
  type StructuredQuoteDraftContentInput,
  type StructuredQuotePersistence,
} from "../src/quote-structured.js";

const actorUserId = "98200000-0000-4000-8000-000000000001" as UserId;
const quoteId = "98200000-0000-4000-8000-000000000002" as QuoteId;
const commandId = "98200000-0000-4000-8000-000000000003";

describe("PLATFORM_STRUCTURED Quote authoring", () => {
  it("normalizes a comparable fixed-price envelope without inventing sums", () => {
    const normalized = normalizeStructuredQuoteContent(content());
    expect(normalized).toMatchObject({
      components: {
        labor: { amountCents: 90_000, description: "Montáž" },
        material: { amountCents: 40_000, description: "Materiál" },
        other: { amountCents: null, description: null },
        transport: { amountCents: 5_000, description: "Paušálna doprava" },
      },
      depositMode: "PERCENTAGE",
      depositPercentageBasisPoints: 3_000,
      estimatedDurationDays: 5,
      estimatedStartOn: "2026-10-05",
      totalAmountCents: 150_000,
    });
    expect(normalized.totalAmountCents).not.toBe(
      Object.values(normalized.components).reduce(
        (sum, component) => sum + (component.amountCents ?? 0),
        0,
      ),
    );
  });

  it("requires exact price shapes for fixed, estimate and range", () => {
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        priceMode: "RANGE",
        rangeMaximumCents: 180_000,
        rangeMinimumCents: 140_000,
        totalAmountCents: null,
      }),
    ).not.toThrow();
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        priceMode: "RANGE",
        rangeMaximumCents: 140_000,
        rangeMinimumCents: 180_000,
        totalAmountCents: null,
      }),
    ).toThrow(/price/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        priceMode: "ESTIMATE",
        rangeMaximumCents: 180_000,
      }),
    ).toThrow(/price/u);
  });

  it("uses integer cents, integer basis points and strict dates", () => {
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        depositPercentageBasisPoints: 3_000.5,
      }),
    ).toThrow(/depositPercentageBasisPoints/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        totalAmountCents: 12.5,
      }),
    ).toThrow(/totalAmountCents/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        estimatedStartOn: "2026-02-30",
      }),
    ).toThrow(/estimatedStartOn/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        validUntil: new Date("invalid"),
      }),
    ).toThrow(/validUntil/u);
  });

  it("requires understandable travel and inspection conditions", () => {
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        components: { ...content().components, transport: { amountCents: 1 } },
      }),
    ).toThrow(/transport.description/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        conditionalOnInspection: true,
        inspectionConditions: null,
      }),
    ).toThrow(/inspectionConditions/u);
  });

  it("bounds scope and blocks pre-confirmation contact/address text", () => {
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        providerNotes: "Volajte mi na +421 900 123 456",
      }),
    ).toThrow(/providerNotes/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        excludedScope: Array.from(
          { length: 21 },
          (_, index) => `Položka ${index}`,
        ),
      }),
    ).toThrow(/excludedScope/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        summary: "Neplatný DEL znak\u007f",
      }),
    ).toThrow(/summary/u);
    const sparse = new Array<string>(1);
    expect(() =>
      normalizeStructuredQuoteContent({ ...content(), includedScope: sparse }),
    ).toThrow(/includedScope/u);
    expect(() =>
      normalizeStructuredQuoteContent({
        ...content(),
        includedScope: [["Vnorená položka"]] as unknown as string[],
      }),
    ).toThrow(/includedScope/u);
  });

  it("normalizes before calling persistence and validates CAS inputs", async () => {
    const saveDraft = vi
      .fn<StructuredQuotePersistence["saveDraft"]>()
      .mockResolvedValue({ status: "NOT_FOUND" });
    const persistence: StructuredQuotePersistence = {
      readOwned: vi.fn<StructuredQuotePersistence["readOwned"]>(),
      saveDraft,
    };
    const service = createStructuredQuoteService({ persistence });
    await expect(
      service.saveDraft({
        actorUserId,
        commandId,
        content: { ...content(), title: "  Rekonštrukcia kúpeľne  " },
        expectedContentRevision: 0,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(saveDraft.mock.calls[0]?.[0].content.title).toBe(
      "Rekonštrukcia kúpeľne",
    );
    expect(() =>
      normalizeSaveStructuredQuoteDraftInput({
        actorUserId,
        commandId,
        content: content(),
        expectedContentRevision: -1,
        quoteId,
        quoteRevision: 1,
      }),
    ).toThrow(/expectedContentRevision/u);
  });

  it("has a distinct idempotency conflict", () => {
    expect(new StructuredQuoteIdempotencyError()).toMatchObject({
      code: "STRUCTURED_QUOTE_IDEMPOTENCY_CONFLICT",
    });
  });
});

function content(): StructuredQuoteDraftContentInput {
  return {
    components: {
      labor: { amountCents: 90_000, description: "Montáž" },
      material: { amountCents: 40_000, description: "Materiál" },
      transport: { amountCents: 5_000, description: "Paušálna doprava" },
    },
    conditionalOnInspection: false,
    currency: "EUR",
    depositMode: "PERCENTAGE",
    depositNotes: "Informačná záloha pred objednaním materiálu",
    depositPercentageBasisPoints: 3_000,
    estimatedDurationDays: 5,
    estimatedStartOn: "2026-10-05",
    excludedScope: ["Likvidácia nebezpečného odpadu"],
    includedScope: ["Montáž", "Bežný spojovací materiál"],
    materialResponsibility: "MIXED",
    priceBasis: "Cena za uvedený rozsah prác a materiálu",
    priceMode: "FIXED",
    providerNotes: "Termín potvrdíme po objednaní materiálu.",
    summary: "Kompletná montáž podľa dohodnutého rozsahu.",
    title: "Rekonštrukcia kúpeľne",
    totalAmountCents: 150_000,
    validUntil: new Date("2026-10-01T21:59:59.000Z"),
    vatStatus: "VAT_INCLUDED",
    warrantyInformation: "Záruka 24 mesiacov na vykonané práce.",
  };
}
