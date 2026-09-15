import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  conversationHrefForState,
  JobInvitationDetail,
  loadJobInvitationDetail,
  submitJobInvitationAction,
} from "./job-invitation-detail";

const invitationId = "9d300000-0000-4000-8000-000000000001";
const requestId = "9d300000-0000-4000-8000-000000000002";
const commandId = "9d300000-0000-4000-8000-000000000003";

describe("job invitation detail", () => {
  it("renders a passive loading boundary without changing business state", () => {
    const html = renderToStaticMarkup(
      <JobInvitationDetail invitationId={invitationId} />,
    );
    expect(html).toContain("Načítavam pozvanie");
    expect(html).not.toMatch(/Mám záujem|Odmietnuť|ENGAGED/u);
  });

  it("exposes the conversation entry only after engagement", () => {
    expect(conversationHrefForState(invitationId, "PENDING")).toBeNull();
    expect(conversationHrefForState(invitationId, "ENGAGED")).toBe(
      `/konverzacie/pozvanka/${invitationId}`,
    );
    expect(conversationHrefForState(invitationId, "NOT_SELECTED")).toBe(
      `/konverzacie/pozvanka/${invitationId}`,
    );
  });

  it("loads the exact safe invitation projection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(detailFixture()));
    await expect(
      loadJobInvitationDetail({ fetch: fetcher, invitationId }),
    ).resolves.toMatchObject({
      invitation: {
        request: {
          description: "Výmena krytiny na prístrešku",
          municipalityCode: "SK0101528595",
        },
      },
      status: "OK",
    });
    expect(fetcher).toHaveBeenCalledWith(`/v1/me/invitations/${invitationId}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("fails closed if an API response adds exact location or contact data", async () => {
    const fixture = detailFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...fixture,
        request: { ...fixture.request, exactAddress: "Tajná 12" },
      }),
    );
    await expect(
      loadJobInvitationDetail({ fetch: fetcher, invitationId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("loads CSRF only for an explicit action and routes craftsman withdrawal correctly", async () => {
    let actionRequest: RequestInit | undefined;
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (requestUrl(input) === "/v1/auth/session") {
          return Promise.resolve(Response.json({ csrfToken: "csrf-test" }));
        }
        actionRequest = init;
        return Promise.resolve(
          Response.json({ revision: 3, state: "WITHDRAWN", status: "APPLIED" }),
        );
      },
    );
    await expect(
      submitJobInvitationAction({
        action: "WITHDRAW",
        commandId: () => commandId,
        expectedRevision: 2,
        fetch: fetcher,
        invitationId,
        perspective: "CRAFTSMAN",
      }),
    ).resolves.toEqual({ revision: 3, state: "WITHDRAWN", status: "OK" });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/v1/me/invitations/${invitationId}/respond`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(actionRequest?.headers).toMatchObject({
      "x-csrf-token": "csrf-test",
    });
    expect(actionRequest?.body).toBe(
      JSON.stringify({
        action: "WITHDRAW",
        commandId,
        expectedRevision: 2,
      }),
    );
  });
});

function detailFixture() {
  return {
    changedAt: "2026-09-15T08:00:00.000Z",
    competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS",
    counterpartDisplayName: "Zákazník 9D300000",
    customerTrust: {
      permittedReviewComments: [],
      rating: null,
      reviewCount: 0,
    },
    expiresAt: "2026-09-22T08:00:00.000Z",
    id: invitationId,
    jobRequestId: requestId,
    perspective: "CRAFTSMAN",
    request: {
      approximateDistanceKm: 12,
      budget: {
        currency: "EUR",
        maximumAmountCents: 200_000,
        minimumAmountCents: 100_000,
        mode: "RANGE",
      },
      description: "Výmena krytiny na prístrešku",
      details: {
        approximateQuantity: "20 m2",
        customRequirements: null,
        materialResponsibility: "COMBINATION",
        siteInspection: "MAYBE",
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
        mode: "FLEXIBLE",
        startsOn: null,
      },
      title: "Oprava strechy",
    },
    requestContentRevision: 2,
    requestTitle: "Oprava strechy",
    requestVisibleVersion: 1,
    revision: 1,
    state: "PENDING",
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
