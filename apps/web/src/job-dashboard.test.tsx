import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  JobDashboardView,
  loadJobDashboard,
  parseJobContacts,
  parseJobDashboard,
} from "./job-dashboard";

const jobId = "94000000-0000-4000-8000-000000000001";
const invitationId = "94000000-0000-4000-8000-000000000002";
const quoteId = "94000000-0000-4000-8000-000000000003";
const assetId = "94000000-0000-4000-8000-000000000004";
const eventOne = "94000000-0000-4000-8000-000000000005";
const eventTwo = "94000000-0000-4000-8000-000000000006";
function path(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function job() {
  const quote = {
    quoteId,
    revision: 4,
    authoringMode: "EXTERNAL_PDF",
    commercialContent: {
      title: "Oprava",
      includedScope: ["Demontáž"],
      excludedScope: ["Komín"],
      totalAmountCents: 100000,
      vatStatus: "INCLUDED",
      warrantyInformation: "24 mesiacov",
    },
    pdfDownloadPath: `/v1/media/${assetId}/download`,
  };
  return {
    id: jobId,
    state: "CONFIRMED",
    acceptedAt: "2026-09-16T10:00:00.000Z",
    role: "CUSTOMER",
    providerDisplayName: "Majster A",
    customerDisplayName: "Zákazník B",
    winningInvitationId: invitationId,
    request: {
      title: "Strecha",
      description: "Výmena krytiny",
      municipalityCode: "SK-001",
      contentRevision: 2,
      visibleVersion: 3,
      scopeDetails: {
        primaryProfessionCode: "ROOFING",
        relatedProfessionCodes: ["CARPENTRY"],
        skillCodes: ["TILE"],
        specializationCode: null,
        timingMode: "FLEXIBLE",
        startsOn: null,
        endsOn: null,
        completionDeadline: "2026-12-31",
        budgetMode: "RANGE",
        minimumAmountCents: 100000,
        maximumAmountCents: 200000,
        currency: "EUR",
        approximateQuantity: "120 m²",
        customRequirements: "Bez azbestu",
        materialResponsibility: "CRAFTSMAN_PROVIDES",
        siteInspection: "LIKELY",
      },
    },
    quote,
    currentCommercialState: {
      base: {
        source: "BASE_QUOTE",
        quoteId: quote.quoteId,
        revision: quote.revision,
        authoringMode: quote.authoringMode,
        commercialContent: quote.commercialContent,
      },
      approvedChanges: [],
      originalTotalCents: null,
      fixedDeltaCents: null,
      exactTotalCents: null,
      exactTotalUnavailableReason: "BASE_NOT_FIXED",
    },
    supportingDocuments: [
      {
        mediaAssetId: assetId,
        displayFilename: "Príloha.pdf",
        downloadPath: `/v1/media/${assetId}/download`,
      },
    ],
    timeline: [
      {
        eventId: eventTwo,
        eventType: "CONTACT_ADDRESS_UNLOCKED",
        occurredAt: "2026-09-16T10:01:00.000Z",
        actorRole: null,
        reason: null,
      },
      {
        eventId: eventOne,
        eventType: "JOB_CONFIRMED",
        occurredAt: "2026-09-16T10:00:00.000Z",
        actorRole: null,
        reason: null,
      },
    ],
  };
}

function contacts() {
  return {
    jobId,
    locationRevision: 1,
    customer: { email: "customer@example.test", phone: null },
    provider: { email: null, phone: "+421900000000" },
    workLocation: {
      municipalityCode: "SK-001",
      exactAddress: "Súkromná 42",
      mapPin: null,
      textClarification: null,
    },
  };
}

describe("D17-A Job dashboard", () => {
  it("loads only the private job and post-confirmation contacts using safe same-origin GETs", async () => {
    const fetcher = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        Response.json(path(input).endsWith("/contacts") ? contacts() : job()),
      ),
    );
    const result = await loadJobDashboard({ fetch: fetcher, jobId });
    expect(result.status).toBe("OK");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      `/v1/me/jobs/${jobId}`,
      `/v1/me/jobs/${jobId}/contacts`,
    ]);
    expect(
      fetcher.mock.calls.every(
        ([, options]) =>
          options?.credentials === "same-origin" &&
          options.cache === "no-store" &&
          options.method === undefined,
      ),
    ).toBe(true);
  });

  it("fails closed for mismatched jobs, premature contact unlock, unsafe media links, and malformed contacts", async () => {
    expect(parseJobDashboard({ ...job(), id: invitationId }, jobId)).toBeNull();
    expect(
      parseJobDashboard({ ...job(), timeline: [job().timeline[1]] }, jobId),
    ).toBeNull();
    expect(
      parseJobDashboard(
        {
          ...job(),
          request: {
            ...job().request,
            scopeDetails: {
              ...job().request.scopeDetails,
              exactAddress: "Leak",
            },
          },
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDashboard(
        {
          ...job(),
          request: {
            ...job().request,
            scopeDetails: {
              ...job().request.scopeDetails,
              minimumAmountCents: -1,
            },
          },
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDashboard(
        { ...job(), request: { ...job().request, scopeDetails: null } },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDashboard(
        {
          ...job(),
          quote: { ...job().quote, pdfDownloadPath: "https://evil.test/file" },
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDashboard(
        {
          ...job(),
          supportingDocuments: [
            {
              ...job().supportingDocuments[0],
              downloadPath: `/v1/media/${quoteId}/download`,
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDashboard(
        {
          ...job(),
          quote: { ...job().quote, commercialContent: { x: () => "bad" } },
        },
        jobId,
      ),
    ).toBeNull();
    const parsed = parseJobDashboard(job(), jobId);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(
      parseJobContacts({ ...contacts(), jobId: invitationId }, parsed),
    ).toBeNull();
    expect(
      parseJobContacts(
        {
          ...contacts(),
          workLocation: {
            ...contacts().workLocation,
            municipalityCode: "OTHER",
          },
        },
        parsed,
      ),
    ).toBeNull();
    const fetcher = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        Response.json(
          path(input).endsWith("/contacts")
            ? { ...contacts(), jobId: invitationId }
            : job(),
        ),
      ),
    );
    expect(await loadJobDashboard({ fetch: fetcher, jobId })).toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("renders immutable scope, all provided quote terms, PDF, contacts, ordered system timeline, and separate conversation link", () => {
    const parsedJob = parseJobDashboard(job(), jobId);
    expect(parsedJob).not.toBeNull();
    if (!parsedJob) return;
    const parsedContacts = parseJobContacts(contacts(), parsedJob);
    expect(parsedContacts).not.toBeNull();
    if (!parsedContacts) return;
    const html = renderToStaticMarkup(
      <JobDashboardView job={parsedJob} contacts={parsedContacts} />,
    );
    for (const text of [
      "Výmena krytiny",
      "Podrobnosti prijatého zadania",
      "Rozpočet od",
      "Bez azbestu",
      "Demontáž",
      "Komín",
      "24 mesiacov",
      "Príloha.pdf",
      "Ľudia na zákazke",
      "Súkromná 42",
      "customer@example.test",
      "+421900000000",
      `/konverzacie/pozvanka/${invitationId}`,
    ])
      expect(html).toContain(text);
    expect(html).toMatch(/1[^0-9]*000,00[^0-9]*€/u);
    expect(html).toContain(`/v1/media/${assetId}/download`);
    expect(html.indexOf("Zákazka potvrdená")).toBeLessThan(
      html.indexOf("Kontakty a adresa sprístupnené"),
    );
    expect(html.indexOf("Systémová história")).toBeLessThan(
      html.indexOf("Konverzácia"),
    );
    expect(html).toContain("Zrušiť zákazku");
    expect(html).not.toContain("Začať práce");
    expect(html).not.toContain("Pozvať remeselníka na zákazku");
    for (const [state, label] of [
      ["COMPLETION_REQUESTED", "Čaká na potvrdenie dokončenia"],
      ["COMPLETED", "Dokončená zákazka"],
    ] as const) {
      const completion = parseJobDashboard({ ...job(), state }, jobId);
      expect(completion).not.toBeNull();
      if (!completion) continue;
      const completionContacts = parseJobContacts(contacts(), completion);
      expect(completionContacts).not.toBeNull();
      if (!completionContacts) continue;
      const stateHtml = renderToStaticMarkup(
        <JobDashboardView job={completion} contacts={completionContacts} />,
      );
      expect(stateHtml).toContain(label);
      expect(stateHtml).not.toContain("Zrušiť zákazku");
      expect(stateHtml).not.toContain("Pozvať remeselníka na zákazku");
    }
  });

  it("shows a source-linked approved delta and rejects internal PDF identifiers", () => {
    const baseline = job();
    const commercialContent = {
      ...baseline.quote.commercialContent,
      priceMode: "FIXED",
      currency: "EUR",
      vatStatus: "VAT_INCLUDED",
    };
    const quote = { ...baseline.quote, commercialContent };
    const changeOrderId = "94000000-0000-4000-8000-000000000007";
    const revisionId = "94000000-0000-4000-8000-000000000008";
    const change = {
      source: "APPROVED_CHANGE_ORDER",
      changeOrderId,
      revisionId,
      revisionNumber: 1,
      approvedAt: "2026-09-17T10:00:00.000Z",
      terms: {
        title: "Doplnenie montáže",
        reason: "Dohodnutý rozsah",
        changeDescription: "Montáž svietidla",
        scopeAdded: ["Svietidlo"],
        scopeRemoved: [],
        scopeChanged: [],
        priceImpact: {
          mode: "FIXED_DELTA",
          amountCents: 20_000,
          vatStatus: "VAT_INCLUDED",
        },
        scheduleImpact: { mode: "NONE" },
        materialResponsibility: null,
        warrantyChange: null,
        otherConditionChange: null,
        affectedMilestoneIds: [],
      },
    };
    const projected = {
      ...baseline,
      quote,
      currentCommercialState: {
        base: {
          source: "BASE_QUOTE",
          quoteId,
          revision: 4,
          authoringMode: "EXTERNAL_PDF",
          commercialContent,
        },
        approvedChanges: [change],
        originalTotalCents: 100_000,
        fixedDeltaCents: 20_000,
        exactTotalCents: 120_000,
        exactTotalUnavailableReason: null,
      },
    };
    const parsed = parseJobDashboard(projected, jobId);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const parsedContacts = parseJobContacts(contacts(), parsed);
    expect(parsedContacts).not.toBeNull();
    if (!parsedContacts) return;
    const html = renderToStaticMarkup(
      <JobDashboardView job={parsed} contacts={parsedContacts} />,
    );
    expect(html).toContain("Aktuálna obchodná dohoda");
    expect(html).toContain("Záväzné podrobnosti pôvodnej ponuky");
    expect(html).toContain("1 200,00");
    expect(html).toContain(
      `/zakazky/${jobId}/zmeny/${changeOrderId}/revizie/${revisionId}`,
    );
    expect(html).toContain("Doplnenie montáže");
    expect(
      parseJobDashboard(
        {
          ...projected,
          currentCommercialState: {
            ...projected.currentCommercialState,
            approvedChanges: [
              {
                ...change,
                terms: { ...change.terms, externalPdfMediaAssetId: assetId },
              },
            ],
          },
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDashboard(
        {
          ...projected,
          currentCommercialState: {
            ...projected.currentCommercialState,
            exactTotalCents: 130_000,
          },
        },
        jobId,
      ),
    ).toBeNull();
  });

  it("renders provider start and preserved cancellation history only in matching states", () => {
    const provider = parseJobDashboard(
      { ...job(), role: "PRIMARY_PROVIDER" },
      jobId,
    );
    expect(provider).not.toBeNull();
    if (!provider) return;
    const providerContacts = parseJobContacts(contacts(), provider);
    expect(providerContacts).not.toBeNull();
    if (!providerContacts) return;
    expect(
      renderToStaticMarkup(
        <JobDashboardView job={provider} contacts={providerContacts} />,
      ),
    ).toContain("Začať práce");
    expect(
      renderToStaticMarkup(
        <JobDashboardView job={provider} contacts={providerContacts} />,
      ),
    ).toContain(`/remeselnici?jobId=${jobId}`);

    const cancelled = parseJobDashboard(
      {
        ...job(),
        state: "CANCELLED",
        timeline: [
          ...job().timeline,
          {
            eventId: "86200000-0000-4000-8000-000000000099",
            eventType: "JOB_CANCELLED",
            occurredAt: "2026-09-16T10:05:00.000Z",
            actorRole: "CUSTOMER",
            reason: "Práce sa už nemôžu uskutočniť.",
          },
        ],
      },
      jobId,
    );
    expect(cancelled).not.toBeNull();
    if (!cancelled) return;
    const cancelledContacts = parseJobContacts(contacts(), cancelled);
    expect(cancelledContacts).not.toBeNull();
    if (!cancelledContacts) return;
    const html = renderToStaticMarkup(
      <JobDashboardView job={cancelled} contacts={cancelledContacts} />,
    );
    expect(html).toContain("Zákazka zrušená");
    expect(html).toContain("Práce sa už nemôžu uskutočniť.");
    expect(html).not.toContain("Zrušiť zákazku");
    expect(html).not.toContain("Pozvať remeselníka na zákazku");
  });

  it("renders only accepted participation and historical departure events, never pending invitations", () => {
    const joined = {
      eventId: "94000000-0000-4000-8000-000000000020",
      eventType: "PARTICIPANT_JOINED",
      occurredAt: "2026-09-16T10:02:00.000Z",
      actorRole: "PARTICIPANT",
      reason: null,
    };
    const left = {
      ...joined,
      eventId: "94000000-0000-4000-8000-000000000021",
      eventType: "PARTICIPANT_LEFT",
      occurredAt: "2026-09-16T10:03:00.000Z",
    };
    const removed = {
      ...joined,
      eventId: "94000000-0000-4000-8000-000000000022",
      eventType: "PARTICIPANT_REMOVED",
      actorRole: "PRIMARY_PROVIDER",
      occurredAt: "2026-09-16T10:04:00.000Z",
    };
    const parsed = parseJobDashboard(
      { ...job(), timeline: [...job().timeline, joined, left, removed] },
      jobId,
    );
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const parsedContacts = parseJobContacts(contacts(), parsed);
    expect(parsedContacts).not.toBeNull();
    if (!parsedContacts) return;
    const html = renderToStaticMarkup(
      <JobDashboardView job={parsed} contacts={parsedContacts} />,
    );
    expect(html).toContain("Účastník prijal účasť");
    expect(html).toContain("Účastník ukončil účasť");
    expect(html).toContain("Hlavný poskytovateľ ukončil účasť");
    expect(html).not.toMatch(/pozvank[auy].*účastník|odmietol účasť/iu);
    for (const invalid of [
      { ...joined, eventType: "PARTICIPANT_INVITED" },
      { ...joined, eventType: "PARTICIPANT_DECLINED" },
      { ...joined, actorRole: "PRIMARY_PROVIDER" },
      { ...left, actorRole: null },
      { ...removed, actorRole: "PARTICIPANT" },
      { ...joined, reason: "private" },
    ])
      expect(
        parseJobDashboard(
          { ...job(), timeline: [...job().timeline, invalid] },
          jobId,
        ),
      ).toBeNull();
  });
});
