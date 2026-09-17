import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { serializeQuoteComparison } from "@portal/domain";

import {
  loadAcceptanceRecap,
  QuoteAcceptanceRecap,
  QuoteAcceptanceRecapView,
  submitQuoteAcceptance,
} from "./quote-acceptance-recap";
import type { InvitationDetailView } from "./job-invitation-detail";

const requestId = "83000000-0000-4000-8000-000000000001";
const quoteId = "83000000-0000-4000-8000-000000000002";
const invitationId = "83000000-0000-4000-8000-000000000003";
const userId = "83000000-0000-4000-8000-000000000005";
const supportingAssetId = "83000000-0000-4000-8000-000000000006";

describe("D16 final Quote recap", () => {
  it("loads only the selected private Quote, its owned invitation and the current account", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      paths.push(path);
      if (path.endsWith("/quote-comparison")) {
        return Promise.resolve(Response.json(comparison()));
      }
      if (path.endsWith(`/quotes/${quoteId}/lifecycle?quoteRevision=1`)) {
        return Promise.resolve(Response.json(lifecycleContext()));
      }
      if (path.endsWith(`/invitations/${invitationId}/versions/2`)) {
        return Promise.resolve(Response.json(invitation()));
      }
      if (path === "/v1/auth/session") {
        return Promise.resolve(
          Response.json({ csrfToken: "csrf-test", user: { id: userId } }),
        );
      }
      if (path.endsWith(`/job-requests/${requestId}/versions/2`))
        return Promise.resolve(Response.json(versionSnapshot()));
      if (
        path === `/v1/me/quotes/${quoteId}/revisions/1/supporting-documents`
      ) {
        return Promise.resolve(Response.json(supportingDocuments()));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const result = await loadAcceptanceRecap({
      fetch: fetcher,
      jobRequestId: requestId,
      quoteId,
    });
    expect(result).toMatchObject({
      status: "OK",
      location: versionSnapshot().sections[0]?.payload,
      supportingDocuments: supportingDocuments().documents,
      userId,
    });
    expect(paths.sort()).toEqual(
      [
        `/v1/me/job-requests/${requestId}/quote-comparison`,
        `/v1/me/quotes/${quoteId}/lifecycle?quoteRevision=1`,
        `/v1/me/invitations/${invitationId}/versions/2`,
        `/v1/me/quotes/${quoteId}/revisions/1/supporting-documents`,
        `/v1/me/job-requests/${requestId}/versions/2`,
        "/v1/auth/session",
      ].sort(),
    );
    expect(
      fetcher.mock.calls.every((call) => call[1]?.method === undefined),
    ).toBe(true);
    expect(fetcher.mock.contexts).toContain(globalThis);
  });

  it("rejects a context for a different Quote revision before loading request details", async () => {
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      paths.push(path);
      return Promise.resolve(
        Response.json(
          path.endsWith("/quote-comparison")
            ? comparison()
            : { ...lifecycleContext(), quoteRevision: 2 },
        ),
      );
    });
    await expect(
      loadAcceptanceRecap({ fetch: fetcher, jobRequestId: requestId, quoteId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(paths).toEqual([
      `/v1/me/job-requests/${requestId}/quote-comparison`,
      `/v1/me/quotes/${quoteId}/lifecycle?quoteRevision=1`,
    ]);
  });

  it("fails closed for a foreign or malformed selection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(comparison()));
    await expect(
      loadAcceptanceRecap({
        fetch: fetcher,
        jobRequestId: requestId,
        quoteId: invitationId,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    await expect(
      loadAcceptanceRecap({
        fetch: fetcher,
        jobRequestId: "../other",
        quoteId,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the exact supporting-document list is missing or unsafe", async () => {
    for (const payload of [
      {
        documents: [
          {
            ...supportingDocuments().documents[0],
            downloadPath: "https://other.test/file",
          },
        ],
      },
      {
        documents: [
          supportingDocuments().documents[0],
          supportingDocuments().documents[0],
        ],
      },
      { documents: null },
    ]) {
      const fetcher = vi.fn<typeof fetch>((input) => {
        const path =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (path.endsWith("/quote-comparison"))
          return Promise.resolve(Response.json(comparison()));
        if (path.endsWith(`/quotes/${quoteId}/lifecycle?quoteRevision=1`))
          return Promise.resolve(Response.json(lifecycleContext()));
        if (path.endsWith(`/invitations/${invitationId}/versions/2`))
          return Promise.resolve(Response.json(invitation()));
        if (path === "/v1/auth/session")
          return Promise.resolve(
            Response.json({ csrfToken: "csrf-test", user: { id: userId } }),
          );
        if (path.endsWith(`/job-requests/${requestId}/versions/2`))
          return Promise.resolve(Response.json(versionSnapshot()));
        if (path.endsWith("/supporting-documents"))
          return Promise.resolve(Response.json(payload));
        return Promise.resolve(new Response(null, { status: 404 }));
      });
      await expect(
        loadAcceptanceRecap({
          fetch: fetcher,
          jobRequestId: requestId,
          quoteId,
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
  });

  it("fails closed if the owner's exact request location does not match the Quote context", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (path.endsWith("/quote-comparison"))
        return Promise.resolve(Response.json(comparison()));
      if (path.endsWith(`/quotes/${quoteId}/lifecycle?quoteRevision=1`))
        return Promise.resolve(Response.json(lifecycleContext()));
      if (path.endsWith(`/invitations/${invitationId}/versions/2`))
        return Promise.resolve(Response.json(invitation()));
      if (path === "/v1/auth/session")
        return Promise.resolve(
          Response.json({ csrfToken: "csrf-test", user: { id: userId } }),
        );
      if (path.endsWith("/supporting-documents"))
        return Promise.resolve(Response.json(supportingDocuments()));
      if (path.endsWith(`/job-requests/${requestId}/versions/2`))
        return Promise.resolve(
          Response.json({
            ...versionSnapshot(),
            sections: [
              {
                ...versionSnapshot().sections[0],
                payload: {
                  ...versionSnapshot().sections[0]!.payload,
                  municipalityCode: "OTHER",
                },
              },
            ],
          }),
        );
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    await expect(
      loadAcceptanceRecap({ fetch: fetcher, jobRequestId: requestId, quoteId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(
      fetcher.mock.calls.every((call) => call[1]?.method === undefined),
    ).toBe(true);
  });

  it("shows commercial precedence and one explicit confirmation control", () => {
    const html = renderToStaticMarkup(
      <QuoteAcceptanceRecapView
        csrfToken="csrf-test"
        invitation={invitation() as InvitationDetailView}
        location={versionSnapshot().sections[0]!.payload}
        quote={comparison().items[0]!}
        quoteStateRevision={3}
        requestContentRevision={2}
        requestVisibleVersion={1}
        status="OK"
        supportingDocuments={supportingDocuments().documents}
        userId={userId}
      />,
    );
    expect(html).toContain("Záverečná kontrola");
    expect(html).toContain("Majster");
    expect(html).toContain("Oprava strechy");
    expect(html).toContain("nie je pevná konečná cena");
    expect(html).toContain("Podrobným obchodným dokumentom je priložené PDF");
    expect(html).toContain("Podporné dokumenty ponuky");
    expect(html).toContain(`href="/v1/media/${supportingAssetId}/download"`);
    expect(html).toContain("Potvrdiť ponuku a vytvoriť zákazku");
    expect(html).toContain("Presná adresa práce, ak je potrebná");
    expect(html).not.toMatch(/<form|type="submit"|automaticky prijaté/iu);
    expect(
      renderToStaticMarkup(
        <QuoteAcceptanceRecap jobRequestId={requestId} quoteId={quoteId} />,
      ),
    ).toContain("Načítavam rekapituláciu");
  });

  it("shows the native structured scope as the authoritative revision", () => {
    const external = comparison().items[0]!;
    const html = renderToStaticMarkup(
      <QuoteAcceptanceRecapView
        csrfToken="csrf-test"
        invitation={invitation() as InvitationDetailView}
        location={versionSnapshot().sections[0]!.payload}
        quote={{
          ...external,
          authoringMode: "PLATFORM_STRUCTURED",
          conditionalOnInspection: false,
          details: {
            components: {
              labor: { amountCents: 8000, description: "Práca" },
              material: { amountCents: 2000, description: "Materiál" },
              other: { amountCents: null, description: null },
            },
            depositNotes: null,
            priceBasis: "Podľa rozsahu",
            providerNotes: null,
            summary: "Výmena krytiny",
            title: "Štruktúrovaná ponuka",
          },
          excludedScope: ["Maľovanie"],
          includedScope: ["Výmena krytiny"],
          materialResponsibility: "PROVIDER",
          pdfDownloadPath: null,
          price: {
            currency: "EUR",
            mode: "FIXED",
            rangeMaximumCents: null,
            rangeMinimumCents: null,
            totalAmountCents: 10000,
            vatStatus: "VAT_INCLUDED",
          },
        }}
        status="OK"
        quoteStateRevision={3}
        requestContentRevision={2}
        requestVisibleVersion={1}
        supportingDocuments={[]}
        userId={userId}
      />,
    );
    expect(html).toContain("Štruktúrovaná ponuka");
    expect(html).toContain("Výmena krytiny");
    expect(html).toContain("Zabezpečí remeselník");
    expect(html).toContain("Záväzným obchodným obsahom je presná revízia");
    expect(html).toContain("Táto revízia nemá ďalšie podporné dokumenty");
    expect(html).not.toContain(
      "Podrobným obchodným dokumentom je priložené PDF",
    );
  });

  it("posts only after explicit action with exact versions, CSRF and one command", async () => {
    const commandId = "83000000-0000-4000-8000-000000000009";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          acceptedAt: "2026-09-16T18:00:00.000Z",
          jobId: "83000000-0000-4000-8000-000000000008",
          status: "APPLIED",
        },
        { status: 201 },
      ),
    );
    await expect(
      submitQuoteAcceptance({
        commandId,
        csrfToken: "csrf-test",
        expectedQuoteStateRevision: 3,
        expectedRequestContentRevision: 2,
        expectedRequestVisibleVersion: 1,
        fetch: fetcher,
        finalExactAddress: "Syntetická 47",
        jobRequestId: requestId,
        quoteId,
        quoteRevision: 1,
      }),
    ).resolves.toEqual({
      jobId: "83000000-0000-4000-8000-000000000008",
      status: "APPLIED",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      headers: { "x-csrf-token": "csrf-test" },
      method: "POST",
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      commandId,
      explicitlyConfirmed: true,
      expectedQuoteStateRevision: 3,
      expectedRequestContentRevision: 2,
      expectedRequestVisibleVersion: 1,
      finalExactAddress: "Syntetická 47",
      quoteRevision: 1,
    });
  });

  it("never posts malformed confirmation intent and reports stale server state", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "STALE_REVISION" }, { status: 409 }),
      );
    const intent = {
      commandId: "83000000-0000-4000-8000-000000000009",
      csrfToken: "csrf-test",
      expectedQuoteStateRevision: 3,
      expectedRequestContentRevision: 2,
      expectedRequestVisibleVersion: 1,
      fetch: fetcher,
      jobRequestId: requestId,
      quoteId,
      quoteRevision: 1,
    };
    await expect(
      submitQuoteAcceptance({ ...intent, quoteId: "../other" }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(submitQuoteAcceptance(intent)).resolves.toEqual({
      status: "CONFLICT",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

function supportingDocuments() {
  return {
    documents: [
      {
        attachedAt: "2026-09-15T09:00:00.000Z",
        downloadPath: `/v1/media/${supportingAssetId}/download`,
        mediaAssetId: supportingAssetId,
      },
    ],
  };
}

function comparison() {
  return serializeQuoteComparison({
    items: [
      {
        authoringEligible: true,
        authoringMode: "EXTERNAL_PDF",
        conditionalOnInspection: null,
        conversationPath: `/konverzacie/pozvanka/${invitationId}`,
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
          rangeMaximumCents: 20000,
          rangeMinimumCents: 10000,
          totalAmountCents: null,
          vatStatus: "VAT_INCLUDED",
        },
        provider: {
          approvedCredentialCount: 0,
          displayName: "Majster",
          identityVerified: false,
        },
        quoteId,
        quoteRevision: 1,
        submittedAt: "2026-09-15T10:00:00.000Z",
        travelAmountCents: null,
        travelDescription: null,
        validUntil: null,
        warrantyInformation: null,
      },
    ],
    jobRequestId: requestId,
    sort: "RECEIVED",
  });
}

function invitation() {
  return {
    changedAt: "2026-09-15T08:00:00.000Z",
    competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS",
    counterpartDisplayName: "Majster",
    customerTrust: {
      permittedReviewComments: [],
      rating: null,
      reviewCount: 0,
    },
    expiresAt: "2026-09-22T08:00:00.000Z",
    id: invitationId,
    jobRequestId: requestId,
    perspective: "CUSTOMER",
    request: {
      approximateDistanceKm: 12,
      budget: {
        currency: "EUR",
        maximumAmountCents: null,
        minimumAmountCents: null,
        mode: null,
      },
      description: "Výmena krytiny na prístrešku",
      details: {
        approximateQuantity: null,
        customRequirements: null,
        materialResponsibility: null,
        siteInspection: null,
      },
      documentMediaAssetIds: [],
      municipalityCode: "SK0101528595",
      photoMediaAssetIds: [],
      primaryProfessionCode: "PROF:ROOFER",
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      timing: {
        completionDeadline: null,
        endsOn: null,
        mode: null,
        startsOn: null,
      },
      title: "Oprava strechy",
    },
    displayedRequestContentRevision: 2,
    displayedRequestVisibleVersion: 1,
    requestContentRevision: 2,
    requestTitle: "Oprava strechy",
    requestVisibleVersion: 1,
    revision: 2,
    state: "ENGAGED",
  };
}

function lifecycleContext() {
  return {
    deadlinePassed: false,
    lifecycleAcceptanceEligible: true,
    materiallyStale: false,
    quoteId,
    quoteRevision: 1,
    requestContentRevision: 2,
    requestVisibleVersion: 1,
    stateRevision: 3,
    state: "SUBMITTED",
  };
}

function versionSnapshot() {
  return {
    sections: [
      {
        key: "request.location",
        payload: {
          exactAddress: null,
          mapPin: null,
          municipalityCode: "SK0101528595",
          textClarification: null,
        },
        schemaVersion: 1,
      },
    ],
    version: {
      contentRevision: 2,
      jobRequestId: requestId,
      visibleVersion: 1,
    },
  };
}
