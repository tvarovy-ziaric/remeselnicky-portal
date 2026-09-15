import { describe, expect, it } from "vitest";

import {
  QuoteComparisonIntegrityError,
  normalizeQuoteComparisonReadInput,
  serializeQuoteComparison,
} from "../src/quote-comparison.js";

const actorUserId = "10000000-0000-4000-8000-000000000001" as never;
const jobRequestId = "20000000-0000-4000-8000-000000000002" as never;

function card(overrides: Record<string, unknown> = {}) {
  return {
    authoringMode: "PLATFORM_STRUCTURED",
    conditionalOnInspection: false,
    conversationPath:
      "/konverzacie/pozvanka/40000000-0000-4000-8000-000000000004",
    deposit: { amountCents: null, mode: "NONE", percentageBasisPoints: null },
    details: {
      components: {
        labor: { amountCents: 8_000, description: "Práca" },
        material: { amountCents: 2_000, description: "Materiál" },
        other: { amountCents: null, description: null },
      },
      depositNotes: null,
      priceBasis: "Celková cena",
      providerNotes: null,
      summary: "Kompletná montáž",
      title: "Ponuka",
    },
    estimatedDurationDays: 3,
    estimatedStartOn: "2026-10-01",
    excludedScope: [],
    includedScope: ["Montáž"],
    inspectionConditions: null,
    materialResponsibility: "PROVIDER",
    pdfDownloadPath: null,
    price: {
      currency: "EUR",
      mode: "FIXED",
      rangeMaximumCents: null,
      rangeMinimumCents: null,
      totalAmountCents: 10_000,
      vatStatus: "VAT_INCLUDED",
    },
    provider: {
      approvedCredentialCount: 1,
      displayName: "Remeselník",
      identityVerified: true,
    },
    quoteId: "30000000-0000-4000-8000-000000000003",
    quoteRevision: 1,
    submittedAt: "2026-09-01T10:00:00.000Z",
    travelAmountCents: 0,
    travelDescription: "V cene",
    validUntil: "2026-10-01T00:00:00.000Z",
    warrantyInformation: "24 mesiacov",
    ...overrides,
  };
}

describe("Quote comparison contract", () => {
  it("normalizes a customer read and defaults to neutral chronology", () => {
    expect(
      normalizeQuoteComparisonReadInput({ actorUserId, jobRequestId }),
    ).toEqual({ actorUserId, jobRequestId, sort: "RECEIVED" });
  });

  it("sorts only coherent fixed VAT-final totals before the neutral tail", () => {
    const result = serializeQuoteComparison({
      items: [
        card({
          quoteId: "30000000-0000-4000-8000-000000000005",
          submittedAt: "2026-09-01T11:00:00.000Z",
          price: {
            currency: "EUR",
            mode: "RANGE",
            rangeMinimumCents: 1,
            rangeMaximumCents: 2,
            totalAmountCents: null,
            vatStatus: "VAT_INCLUDED",
          },
        }),
        card(),
        card({
          quoteId: "30000000-0000-4000-8000-000000000006",
          submittedAt: "2026-09-01T09:00:00.000Z",
          price: {
            currency: "EUR",
            mode: "ESTIMATE",
            rangeMinimumCents: null,
            rangeMaximumCents: null,
            totalAmountCents: 5_000,
            vatStatus: "NOT_VAT_REGISTERED",
          },
        }),
        card({
          quoteId: "30000000-0000-4000-8000-000000000007",
          submittedAt: "2026-09-01T08:00:00.000Z",
          price: {
            currency: "EUR",
            mode: "FIXED",
            rangeMinimumCents: null,
            rangeMaximumCents: null,
            totalAmountCents: 1,
            vatStatus: "VAT_EXCLUDED",
          },
        }),
      ],
      jobRequestId,
      sort: "LOWEST_COMPARABLE_PRICE",
    });
    expect(result.items.map((item) => item.quoteId)).toEqual([
      "30000000-0000-4000-8000-000000000003",
      "30000000-0000-4000-8000-000000000007",
      "30000000-0000-4000-8000-000000000006",
      "30000000-0000-4000-8000-000000000005",
    ]);
  });

  it.each([
    { ...card(), ownerUserId: actorUserId },
    card({
      price: {
        currency: "EUR",
        mode: "FIXED",
        rangeMaximumCents: null,
        rangeMinimumCents: null,
        totalAmountCents: 0,
        vatStatus: "VAT_INCLUDED",
      },
    }),
    card({ authoringMode: "EXTERNAL_PDF", pdfDownloadPath: null }),
    card({
      conversationPath:
        "/konverzacie/pozvanka/------------------------------------",
    }),
    card({ estimatedStartOn: "2026-02-31" }),
    card({
      provider: {
        approvedCredentialCount: 0,
        displayName: "x",
        identityVerified: false,
        email: "x@example.test",
      },
    }),
    card({
      provider: {
        approvedCredentialCount: 0,
        displayName: "majster@example.test",
        identityVerified: false,
      },
    }),
    card({
      provider: {
        approvedCredentialCount: 0,
        displayName: "+421 900 123 456",
        identityVerified: false,
      },
    }),
    card({
      provider: {
        approvedCredentialCount: 0,
        displayName: "Adresa: Hlavná 12, Bratislava",
        identityVerified: false,
      },
    }),
  ])("fails closed on leakage or corrupt facts", (bad) => {
    expect(() =>
      serializeQuoteComparison({
        items: [bad],
        jobRequestId,
        sort: "RECEIVED",
      }),
    ).toThrow(QuoteComparisonIntegrityError);
  });

  it("accepts only the explicitly confirmed external envelope shape", () => {
    expect(() =>
      serializeQuoteComparison({
        items: [
          card({
            authoringMode: "EXTERNAL_PDF",
            conditionalOnInspection: null,
            details: null,
            estimatedDurationDays: null,
            estimatedStartOn: null,
            excludedScope: null,
            includedScope: null,
            materialResponsibility: "CUSTOMER",
            pdfDownloadPath:
              "/v1/media/40000000-0000-4000-8000-000000000004/download",
            travelAmountCents: null,
            travelDescription: null,
            validUntil: null,
            warrantyInformation: null,
          }),
        ],
        jobRequestId,
        sort: "RECEIVED",
      }),
    ).not.toThrow();
  });

  it("accepts empty scope without interpreting it as an affirmative claim", () => {
    const result = serializeQuoteComparison({
      items: [card({ includedScope: [], excludedScope: [] })],
      jobRequestId,
      sort: "RECEIVED",
    });
    expect(result.items[0]?.includedScope).toEqual([]);
    expect(result.items[0]?.excludedScope).toEqual([]);
  });

  it("rejects sparse scope arrays at the runtime boundary", () => {
    const sparse: string[] = [];
    sparse.length = 1;
    expect(() =>
      serializeQuoteComparison({
        items: [card({ includedScope: sparse })],
        jobRequestId,
        sort: "RECEIVED",
      }),
    ).toThrow(QuoteComparisonIntegrityError);
  });
});
