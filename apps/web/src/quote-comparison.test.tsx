import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { serializeQuoteComparison } from "@portal/domain";

import {
  loadQuoteComparison,
  observeActualVisibility,
  QuoteComparisonEntry,
  QuoteComparisonView,
  recordQuoteComparisonObservation,
} from "./quote-comparison";

const jobRequestId = "83000000-0000-4000-8000-000000000001";

describe("customer Quote comparison", () => {
  it("records only the minimal observation shape and isolates delivery failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf" }))
      .mockRejectedValueOnce(new Error("analytics unavailable"));
    await expect(
      recordQuoteComparisonObservation({
        fetch: fetcher,
        jobRequestId,
        kind: "QUOTE_COMPARISON_OPENED",
      }),
    ).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/me/analytics/r3-observations");
    const payload = JSON.parse(
      (fetcher.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "commandId",
      "jobRequestId",
      "kind",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/price|provider|pdf|storage/iu);
  });

  it("observes a card only after viewport intersection in a visible tab", () => {
    const target = {} as Element;
    const documentTarget = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
    };
    documentTarget.visibilityState = "hidden";
    let callback: IntersectionObserverCallback | undefined;
    class Observer {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "0px";
      thresholds = [0];
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
    }
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("IntersectionObserver", Observer);
    const visible = vi.fn();
    const cleanup = observeActualVisibility(target, visible);
    expect(visible).not.toHaveBeenCalled();
    callback?.(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(visible).not.toHaveBeenCalled();
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(visible).toHaveBeenCalledOnce();
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(visible).toHaveBeenCalledOnce();
    cleanup();
    vi.unstubAllGlobals();
  });

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
    expect(html).toContain("Vybrať túto ponuku");
    expect(html).toContain(
      `/ziadosti/${jobRequestId}/ponuky/83000000-0000-4000-8000-000000000002/potvrdenie`,
    );
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
    expect(fetcher.mock.contexts[0]).toBe(globalThis);
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

  it("shows a prominent warning for a materially stale submitted Quote", () => {
    const stale = fixture();
    const html = renderToStaticMarkup(
      <QuoteComparisonView
        comparison={{
          ...stale,
          items: stale.items.map((item) => ({
            ...item,
            lifecycleAcceptanceEligible: false,
            materiallyStale: true,
          })),
        }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("podstatne zmenila");
    expect(html).not.toContain("Vybrať túto ponuku");
  });
});

function fixture() {
  return serializeQuoteComparison({
    items: [
      {
        authoringEligible: true,
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
        lifecycleAcceptanceEligible: true,
        materiallyStale: false,
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
