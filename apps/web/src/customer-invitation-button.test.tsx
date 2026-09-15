import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CustomerInvitationButton,
  sendCustomerInvitation,
} from "./customer-invitation-button";

const requestId = "9d200000-0000-4000-8000-000000000001";
const profileId = "9d200000-0000-4000-8000-000000000002";
const commandId = "9d200000-0000-4000-8000-000000000003";

describe("customer invitation button", () => {
  it("renders an explicit customer-controlled invitation action", () => {
    const html = renderToStaticMarkup(
      <CustomerInvitationButton
        craftsmanProfileId={profileId}
        jobRequestId={requestId}
      />,
    );
    expect(html).toContain("Pozvať k zákazke");
    expect(html).not.toMatch(/automaticky|broadcast|ownerUserId/iu);
  });

  it("loads CSRF only on selection and sends IDs without ranking facts", async () => {
    let invitationRequest: RequestInit | undefined;
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        if (url === "/v1/auth/session") {
          return Promise.resolve(Response.json({ csrfToken: "csrf-test" }));
        }
        if (url.endsWith(`/job-requests/${requestId}/invitations`)) {
          invitationRequest = init;
          return Promise.resolve(
            Response.json(
              {
                id: commandId,
                revision: 1,
                state: "PENDING",
                status: "APPLIED",
              },
              { status: 201 },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 500 }));
      },
    );
    await expect(
      sendCustomerInvitation({
        commandId: () => commandId,
        craftsmanProfileId: profileId,
        fetch: fetcher,
        jobRequestId: requestId,
      }),
    ).resolves.toBe("SENT");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(invitationRequest?.headers).toMatchObject({
      "x-csrf-token": "csrf-test",
    });
    expect(typeof invitationRequest?.body).toBe("string");
    if (typeof invitationRequest?.body !== "string") {
      throw new Error("Expected serialized invitation body.");
    }
    expect(invitationRequest.body).toBe(
      JSON.stringify({ commandId, craftsmanProfileId: profileId }),
    );
    expect(invitationRequest.body).not.toMatch(
      /score|rank|distance|credential/iu,
    );
  });

  it("maps the active limit and rejects malformed identifiers before fetch", async () => {
    const limitedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          { activeLimit: 5, code: "ACTIVE_LIMIT_REACHED" },
          { status: 409 },
        ),
      );
    await expect(
      sendCustomerInvitation({
        commandId: () => commandId,
        craftsmanProfileId: profileId,
        fetch: limitedFetch,
        jobRequestId: requestId,
      }),
    ).resolves.toBe("LIMIT_REACHED");

    const unused = vi.fn<typeof fetch>();
    await expect(
      sendCustomerInvitation({
        craftsmanProfileId: "invalid",
        fetch: unused,
        jobRequestId: requestId,
      }),
    ).resolves.toBe("UNAVAILABLE");
    expect(unused).not.toHaveBeenCalled();
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
