import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderParticipantInvitationButton,
  sendProviderParticipantInvitation,
} from "./provider-participant-invitation-button";

const jobId = "99000000-0000-4000-8000-000000000020";
const craftsmanProfileId = "99000000-0000-4000-8000-000000000001";
const commandId = "99000000-0000-4000-8000-000000000021";
const participantId = "99000000-0000-4000-8000-000000000022";
const invitedAt = "2026-09-16T08:00:00.000Z";

function input(
  fetcher: typeof fetch,
  profileType: "INDIVIDUAL" | "COMPANY" = "INDIVIDUAL",
) {
  return {
    jobId,
    craftsmanProfileId,
    profileType,
    commandId,
    fetch: fetcher,
  } as const;
}

describe("provider participant invitation action", () => {
  it("renders explicit action without implying verified participation", () => {
    const html = renderToStaticMarkup(
      <ProviderParticipantInvitationButton
        jobId={jobId}
        craftsmanProfileId={craftsmanProfileId}
        profileType="INDIVIDUAL"
      />,
    );
    expect(html).toContain("Pozvať na zákazku");
    expect(html).not.toMatch(/overená účasť|zákazník|adresa|telefón/iu);
    expect(
      renderToStaticMarkup(
        <ProviderParticipantInvitationButton
          jobId={jobId}
          craftsmanProfileId={craftsmanProfileId}
          profileType="COMPANY"
        />,
      ),
    ).toBe("");
  });

  it("requires CSRF and sends only the authorized Job/person identifiers plus a command ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json(
          { status: "APPLIED", participantId, invitedAt },
          { status: 201 },
        ),
      );
    await expect(
      sendProviderParticipantInvitation(input(fetcher)),
    ).resolves.toEqual({
      status: "SENT",
      participantId,
    });
    expect(fetcher.mock.calls[0]).toEqual([
      "/v1/auth/csrf",
      { cache: "no-store", credentials: "same-origin" },
    ]);
    expect(fetcher.mock.calls[1]).toEqual([
      `/v1/me/jobs/${jobId}/participants`,
      {
        body: JSON.stringify({ commandId, craftsmanProfileId }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
        method: "POST",
      },
    ]);
  });

  it("never posts for a company, malformed identifiers, or a corrupt CSRF response", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      sendProviderParticipantInvitation(input(fetcher, "COMPANY")),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    await expect(
      sendProviderParticipantInvitation({ ...input(fetcher), jobId: "bad" }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(
      Response.json({ csrfToken: "csrf-test", leaked: true }),
    );
    await expect(
      sendProviderParticipantInvitation(input(fetcher)),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unverified outcomes, extra private fields, and safe server denial", async () => {
    for (const body of [
      {
        status: "APPLIED",
        participantId,
        invitedAt,
        customerContact: "private",
      },
      { status: "APPLIED", participantId: "bad", invitedAt },
      { status: "APPLIED", participantId, invitedAt: "invalid" },
      { status: "UNKNOWN", participantId, invitedAt },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        sendProviderParticipantInvitation(input(fetcher)),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    for (const status of [403, 404, 409]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(
        sendProviderParticipantInvitation(input(fetcher)),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
  });
});
