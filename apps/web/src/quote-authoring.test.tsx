import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createStructuredQuoteDraft,
  QuoteAuthoring,
  saveStructuredQuoteDraft,
  submitQuoteDraft,
} from "./quote-authoring";

const conversationId = "8b000000-0000-4000-8000-000000000001";
const invitationId = "8b000000-0000-4000-8000-000000000002";
const quoteId = "8b000000-0000-4000-8000-000000000003";
const commandId = "8b000000-0000-4000-8000-000000000004";

describe("Quote authoring web boundary", () => {
  it("renders a passive private loading state", () => {
    const html = renderToStaticMarkup(
      <QuoteAuthoring
        conversationId={conversationId}
        invitationId={invitationId}
      />,
    );
    expect(html).toContain("Načítavam cenovú ponuku");
    expect(html).not.toMatch(/Odoslať uloženú|storageKey|sha256/iu);
  });

  it("creates a structured draft with a real CSRF session", async () => {
    const fetcher = sequenceFetcher(
      Response.json({ csrfToken: "csrf-quote" }),
      Response.json({ quote: quoteFixture(), status: "APPLIED" }),
    );
    await expect(
      createStructuredQuoteDraft({
        commandId: () => commandId,
        conversationId,
        fetch: fetcher,
        requestContentRevision: 4,
        requestVisibleVersion: 3,
      }),
    ).resolves.toMatchObject({ quote: { id: quoteId }, status: "OK" });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/conversations/${conversationId}/quotes`,
    );
    const request = fetcher.mock.calls[1]?.[1];
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("x-csrf-token")).toBe(
      "csrf-quote",
    );
    const body = requestBody(fetcher, 1);
    expect(body).toEqual({
      authoringMode: "PLATFORM_STRUCTURED",
      commandId,
      requestContentRevision: 4,
      requestVisibleVersion: 3,
    });
  });

  it("normalizes an exact EUR amount, preserves CAS and rejects corrupt output", async () => {
    const saved = sequenceFetcher(
      Response.json({ csrfToken: "csrf-quote" }),
      Response.json({ content: structuredFixture(2), status: "SAVED" }),
    );
    await expect(
      saveStructuredQuoteDraft({
        amountEuros: "1250,50",
        commandId: () => commandId,
        expectedContentRevision: 1,
        fetch: saved,
        priceBasis: "Práca a dohodnutý materiál.",
        quoteId,
        quoteRevision: 1,
        summary: "Realizácia podľa zadania.",
        title: "Ponuka na realizáciu",
      }),
    ).resolves.toMatchObject({
      content: { contentRevision: 2, totalAmountCents: 125_050 },
      status: "OK",
    });
    expect(requestBody(saved, 1)).toMatchObject({
      expectedContentRevision: 1,
      content: { totalAmountCents: 125_050 },
    });

    const corrupt = sequenceFetcher(
      Response.json({ csrfToken: "csrf-quote" }),
      Response.json({
        content: { ...structuredFixture(2), storageKey: "private/leak" },
        status: "SAVED",
      }),
    );
    await expect(
      saveStructuredQuoteDraft({
        amountEuros: "1250.50",
        commandId: () => commandId,
        expectedContentRevision: 1,
        fetch: corrupt,
        priceBasis: "Práca a dohodnutý materiál.",
        quoteId,
        quoteRevision: 1,
        summary: "Realizácia podľa zadania.",
        title: "Ponuka na realizáciu",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("submits the exact draft revision without manufacturing state", async () => {
    const fetcher = sequenceFetcher(
      Response.json({ csrfToken: "csrf-quote" }),
      Response.json({ quote: submittedQuoteFixture(), status: "APPLIED" }),
    );
    await expect(
      submitQuoteDraft({
        commandId: () => commandId,
        expectedDraftStateRevision: 1,
        expectedSubmittedStateRevision: null,
        fetch: fetcher,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toMatchObject({
      quote: { currentDraft: null, currentSubmitted: { state: "SUBMITTED" } },
      status: "OK",
    });
    expect(requestBody(fetcher, 1)).toEqual({
      commandId,
      expectedDraftStateRevision: 1,
      expectedSubmittedStateRevision: null,
    });
  });
});

function sequenceFetcher(...responses: Response[]) {
  return vi.fn<typeof fetch>(() => {
    const response = responses.shift();
    return response === undefined
      ? Promise.reject(new Error("unexpected request"))
      : Promise.resolve(response);
  });
}

function requestBody(
  fetcher: ReturnType<typeof sequenceFetcher>,
  index: number,
) {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error("JSON request body required");
  return JSON.parse(body) as unknown;
}

function quoteFixture() {
  return {
    conversationId,
    createdAt: "2026-09-15T12:00:00.000Z",
    currentDraft: revision("DRAFT", null),
    currentSubmitted: null,
    id: quoteId,
    invitationId,
    jobRequestId: "8b000000-0000-4000-8000-000000000005",
    participantRole: "CRAFTSMAN",
    revisions: [revision("DRAFT", null)],
  };
}

function submittedQuoteFixture() {
  const submitted = revision("SUBMITTED", "2026-09-15T12:01:00.000Z");
  return {
    ...quoteFixture(),
    currentDraft: null,
    currentSubmitted: submitted,
    revisions: [submitted],
  };
}

function revision(state: "DRAFT" | "SUBMITTED", submittedAt: string | null) {
  return {
    authoringMode: "PLATFORM_STRUCTURED",
    changedAt: "2026-09-15T12:00:00.000Z",
    createdAt: "2026-09-15T12:00:00.000Z",
    rejectionReason: null,
    requestContentRevision: 4,
    requestVisibleVersion: 3,
    revision: 1,
    state,
    stateRevision: 1,
    submittedAt,
  };
}

function structuredFixture(contentRevision: number) {
  return {
    changedAt: "2026-09-15T12:00:00.000Z",
    components: {
      labor: { amountCents: null, description: null },
      material: { amountCents: null, description: null },
      other: { amountCents: null, description: null },
      transport: { amountCents: null, description: null },
    },
    conditionalOnInspection: false,
    contentRevision,
    currency: "EUR",
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
    priceBasis: "Práca a dohodnutý materiál.",
    priceMode: "FIXED",
    providerNotes: null,
    quoteId,
    quoteRevision: 1,
    rangeMaximumCents: null,
    rangeMinimumCents: null,
    summary: "Realizácia podľa zadania.",
    title: "Ponuka na realizáciu",
    totalAmountCents: 125_050,
    validUntil: null,
    vatStatus: "VAT_INCLUDED",
    warrantyInformation: null,
  };
}
