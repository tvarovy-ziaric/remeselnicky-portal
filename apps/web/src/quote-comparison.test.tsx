import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { serializeQuoteComparison } from "@portal/domain";

import {
  loadQuoteComparison,
  QuoteComparisonEntry,
  QuoteComparisonView,
} from "./quote-comparison";

const jobRequestId = "83000000-0000-4000-8000-000000000001";

describe("customer Quote comparison", () => {
  it("renders a private passive boundary and a responsive neutral card", () => {
    expect(
      renderToStaticMarkup(
        <QuoteComparisonEntry jobRequestId={jobRequestId} />,
      ),
    ).toContain("Načítavam ponuky");
    const html = renderToStaticMarkup(
      <QuoteComparisonView comparison={fixture()} />,
    );
    expect(html).toContain("Porovnanie ponúk");
    expect(html).toContain("Neuvedené");
    expect(html).toContain("Otvoriť konverzáciu");
    expect(html).not.toMatch(
      /najlepšia ponuka|ownerUserId|storageKey|competitor/iu,
    );
  });

  it("loads through the exact private endpoint and rejects DTO leakage", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(fixture()));
    await expect(
      loadQuoteComparison({ fetch: fetcher, jobRequestId }),
    ).resolves.toMatchObject({ status: "OK" });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/job-requests/${jobRequestId}/quote-comparison`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const leaked = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ...fixture(), customerProfileId: "secret" }),
      );
    await expect(
      loadQuoteComparison({ fetch: leaked, jobRequestId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    await expect(
      loadQuoteComparison({ fetch: fetcher, jobRequestId: "../secret" }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});

function fixture() {
  return serializeQuoteComparison({
    items: [
      {
        authoringMode: "EXTERNAL_PDF",
        conditionalOnInspection: null,
        conversationPath:
          "/konverzacie/pozvanka/83000000-0000-4000-8000-000000000003",
        deposit: { amountCents: null, mode: null, percentageBasisPoints: null },
        details: null,
        estimatedDurationDays: null,
        estimatedStartOn: null,
        excludedScope: null,
        includedScope: null,
        inspectionConditions: null,
        materialResponsibility: null,
        pdfDownloadPath:
          "/v1/media/83000000-0000-4000-8000-000000000004/download",
        price: {
          currency: "EUR",
          mode: "RANGE",
          rangeMaximumCents: 20_000,
          rangeMinimumCents: 10_000,
          totalAmountCents: null,
          vatStatus: "VAT_INCLUDED",
        },
        provider: {
          approvedCredentialCount: 0,
          displayName: "Majster",
          identityVerified: false,
        },
        quoteId: "83000000-0000-4000-8000-000000000002",
        quoteRevision: 1,
        submittedAt: "2026-09-15T10:00:00.000Z",
        travelAmountCents: null,
        travelDescription: null,
        validUntil: null,
        warrantyInformation: null,
      },
    ],
    jobRequestId,
    sort: "RECEIVED",
  });
}
