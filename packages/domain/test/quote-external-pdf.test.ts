import { describe, expect, it } from "vitest";

import {
  normalizeExternalPdfQuoteEnvelope,
  normalizeSaveExternalPdfQuoteDraftInput,
  type QuoteId,
  type UserId,
} from "../src/index.js";

const actorUserId = "98400000-0000-4000-8000-000000000001" as UserId;
const quoteId = "98400000-0000-4000-8000-000000000002" as QuoteId;
const pdfAssetId = "98400000-0000-4000-8000-000000000003";

describe("EXTERNAL_PDF Quote envelope", () => {
  it("accepts the minimal provider-confirmed fixed envelope", () => {
    expect(normalizeExternalPdfQuoteEnvelope(envelope())).toMatchObject({
      currency: "EUR",
      priceMode: "FIXED",
      providerConfirmedSummaryMatchesPdf: true,
      totalAmountCents: 150_000,
      vatStatus: "VAT_INCLUDED",
    });
  });

  it("requires confirmation and exact fixed/range shapes", () => {
    expect(() =>
      normalizeExternalPdfQuoteEnvelope({
        ...envelope(),
        providerConfirmedSummaryMatchesPdf: false as true,
      }),
    ).toThrow(/providerConfirmed/u);
    expect(() =>
      normalizeExternalPdfQuoteEnvelope({
        ...envelope(),
        priceMode: "RANGE",
        totalAmountCents: null,
      }),
    ).toThrow(/price/u);
    expect(() =>
      normalizeExternalPdfQuoteEnvelope({
        ...envelope(),
        priceMode: "RANGE",
        totalAmountCents: null,
        rangeMinimumCents: 100_000,
        rangeMaximumCents: 160_000,
      }),
    ).not.toThrow();
  });

  it("uses bounded integer cents and basis points", () => {
    expect(() =>
      normalizeExternalPdfQuoteEnvelope({
        ...envelope(),
        totalAmountCents: 1.5,
      }),
    ).toThrow(/totalAmountCents/u);
    expect(() =>
      normalizeExternalPdfQuoteEnvelope({
        ...envelope(),
        depositMode: "PERCENTAGE",
        depositPercentageBasisPoints: 10_001,
      }),
    ).toThrow(/depositPercentage/u);
  });

  it("validates exact IDs and CAS", () => {
    expect(() =>
      normalizeSaveExternalPdfQuoteDraftInput({
        actorUserId,
        commandId: "bad",
        envelope: envelope(),
        expectedContentRevision: 0,
        pdfAssetId,
        quoteId,
        quoteRevision: 1,
      }),
    ).toThrow(/commandId/u);
    expect(() =>
      normalizeSaveExternalPdfQuoteDraftInput({
        actorUserId,
        commandId: "98400000-0000-4000-8000-000000000004",
        envelope: envelope(),
        expectedContentRevision: -1,
        pdfAssetId,
        quoteId,
        quoteRevision: 1,
      }),
    ).toThrow(/expectedContentRevision/u);
  });
});

function envelope() {
  return {
    currency: "EUR" as const,
    priceMode: "FIXED" as const,
    providerConfirmedSummaryMatchesPdf: true as const,
    totalAmountCents: 150_000,
    vatStatus: "VAT_INCLUDED" as const,
  };
}
