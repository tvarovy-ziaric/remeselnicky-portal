import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  JobInvitationInbox,
  loadJobInvitationInbox,
} from "./job-invitation-inbox";

const invitationId = "9d400000-0000-4000-8000-000000000001";
const requestId = "9d400000-0000-4000-8000-000000000002";

describe("job invitation inbox", () => {
  it("renders a passive private loading boundary", () => {
    const html = renderToStaticMarkup(<JobInvitationInbox />);
    expect(html).toContain("Načítavam pozvania");
    expect(html).not.toMatch(/customerProfileId|ownerUserId|competitor/iu);
  });

  it("accepts a bounded allowlisted list", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [
          {
            changedAt: "2026-09-15T08:00:00.000Z",
            counterpartDisplayName: "Majster Test",
            expiresAt: "2026-09-22T08:00:00.000Z",
            id: invitationId,
            jobRequestId: requestId,
            perspective: "CUSTOMER",
            requestTitle: "Oprava strechy",
            revision: 2,
            state: "ENGAGED",
          },
        ],
      }),
    );
    await expect(loadJobInvitationInbox({ fetch: fetcher })).resolves.toEqual({
      items: [expect.objectContaining({ id: invitationId, state: "ENGAGED" })],
      status: "OK",
    });
  });

  it("rejects private or competitor fields in a corrupt API response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [
          {
            changedAt: "2026-09-15T08:00:00.000Z",
            competitorProfileId: "secret",
            counterpartDisplayName: "Majster Test",
            expiresAt: "2026-09-22T08:00:00.000Z",
            id: invitationId,
            jobRequestId: requestId,
            perspective: "CUSTOMER",
            requestTitle: "Oprava strechy",
            revision: 1,
            state: "PENDING",
          },
        ],
      }),
    );
    await expect(loadJobInvitationInbox({ fetch: fetcher })).resolves.toEqual({
      status: "UNAVAILABLE",
    });
  });
});
