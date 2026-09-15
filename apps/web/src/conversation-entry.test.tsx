import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationEntry,
  loadConversationByInvitation,
} from "./conversation-entry";

const invitationId = "9e300000-0000-4000-8000-000000000001";

describe("conversation entry", () => {
  it("renders a passive private loading boundary", () => {
    const html = renderToStaticMarkup(
      <ConversationEntry invitationId={invitationId} />,
    );
    expect(html).toContain("Načítavam konverzáciu");
    expect(html).not.toContain("textarea");
  });

  it("loads the exact invitation-scoped allowlist", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(conversationFixture()));
    await expect(
      loadConversationByInvitation({ fetch: fetcher, invitationId }),
    ).resolves.toMatchObject({
      conversation: { access: "WRITABLE", invitationId },
      status: "OK",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/invitations/${invitationId}/conversation`,
      { cache: "no-store", credentials: "same-origin" },
    );
  });

  it("fails closed if the API adds participant or message data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...conversationFixture(),
        messages: [{ body: "private" }],
      }),
    );
    await expect(
      loadConversationByInvitation({ fetch: fetcher, invitationId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("maps pre-engagement and competitor denial to the same unavailable view", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: "NOT_FOUND" }, { status: 404 }));
    await expect(
      loadConversationByInvitation({ fetch: fetcher, invitationId }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
  });
});

function conversationFixture() {
  return {
    access: "WRITABLE",
    counterpartDisplayName: "Majster Test",
    createdAt: "2026-09-15T08:00:00.000Z",
    id: "9e300000-0000-4000-8000-000000000002",
    invitationId,
    jobRequestId: "9e300000-0000-4000-8000-000000000003",
    participantRole: "CUSTOMER",
    requestTitle: "Oprava strechy",
  };
}
