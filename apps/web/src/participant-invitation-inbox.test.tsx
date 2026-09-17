import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  getParticipantDecisionCommand,
  loadParticipantInvitationPage,
  parseParticipantInvitationPage,
  ParticipantInvitationInbox,
  sendParticipantDecision,
} from "./participant-invitation-inbox";

const participantId = "9d400000-0000-4000-8000-000000000011";
const jobId = "9d400000-0000-4000-8000-000000000012";
const commandId = "9d400000-0000-4000-8000-000000000013";
const otherParticipantId = "9d400000-0000-4000-8000-000000000014";
const otherCommandId = "9d400000-0000-4000-8000-000000000015";
const invitedAt = "2026-09-16T08:00:00.000Z";
const item = {
  participantId,
  jobId,
  providerDisplayName: "Majster Test",
  municipalityName: "Bratislava",
  primaryProfessionCode: "PROF:ELECTRICIAN",
  invitedAt,
};

describe("participant invitation inbox", () => {
  it("retains an uncertain command per participant across intervening actions", () => {
    const attempts = new Map<
      string,
      { decision: "ACCEPT" | "DECLINE"; commandId: string }
    >();
    expect(
      getParticipantDecisionCommand(
        attempts,
        participantId,
        "ACCEPT",
        () => commandId,
      ),
    ).toBe(commandId);
    expect(
      getParticipantDecisionCommand(
        attempts,
        otherParticipantId,
        "DECLINE",
        () => otherCommandId,
      ),
    ).toBe(otherCommandId);
    expect(
      getParticipantDecisionCommand(attempts, participantId, "ACCEPT", () => {
        throw new Error("must reuse");
      }),
    ).toBe(commandId);
    expect(
      getParticipantDecisionCommand(attempts, participantId, "DECLINE", () => {
        throw new Error("must not switch");
      }),
    ).toBeNull();
    attempts.delete(participantId);
    expect(
      getParticipantDecisionCommand(
        attempts,
        participantId,
        "DECLINE",
        () => commandId,
      ),
    ).toBe(commandId);
  });
  it("does not imply verification or disclose invitation details before private loading", () => {
    const html = renderToStaticMarkup(<ParticipantInvitationInbox />);
    expect(html).toContain("Načítavajú sa pozvánky");
    expect(html).not.toMatch(/prija[tť]|overená účasť|zákazník|adresa/iu);
  });

  it("accepts the exact bounded private projection and cursor", async () => {
    const payload = {
      items: [item],
      nextCursor: { invitedAt, id: participantId },
    };
    expect(parseParticipantInvitationPage(payload)).toEqual(payload);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(payload));
    await expect(
      loadParticipantInvitationPage({ fetch: fetcher }),
    ).resolves.toEqual({
      status: "OK",
      page: payload,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/me/job-participations/invitations?limit=20",
      { cache: "no-store", credentials: "same-origin" },
    );
  });

  it("rejects leaked contact/address and customer identifiers, duplicate rows and corrupt cursor", () => {
    for (const extra of ["customerContact", "exactAddress", "customerUserId"]) {
      expect(
        parseParticipantInvitationPage({
          items: [{ ...item, [extra]: "private" }],
          nextCursor: null,
        }),
      ).toBeNull();
    }
    expect(
      parseParticipantInvitationPage({ items: [item, item], nextCursor: null }),
    ).toBeNull();
    expect(
      parseParticipantInvitationPage({
        items: [item],
        nextCursor: { invitedAt, id: jobId },
      }),
    ).toBeNull();
    expect(
      parseParticipantInvitationPage({
        items: [item],
        nextCursor: null,
        secret: true,
      }),
    ).toBeNull();
  });

  it("accepts bounded company provider names but rejects blank or control characters", () => {
    expect(
      parseParticipantInvitationPage({
        items: [{ ...item, providerDisplayName: "A".repeat(255) }],
        nextCursor: null,
      }),
    ).not.toBeNull();
    for (const providerDisplayName of [
      " ",
      "Majster\nSúkromné",
      "A".repeat(256),
    ])
      expect(
        parseParticipantInvitationPage({
          items: [{ ...item, providerDisplayName }],
          nextCursor: null,
        }),
      ).toBeNull();
  });

  it("rejects malformed identity, timestamp, and oversized pages", () => {
    expect(
      parseParticipantInvitationPage({
        items: [{ ...item, participantId: "x" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseParticipantInvitationPage({
        items: [{ ...item, invitedAt: "tomorrow" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parseParticipantInvitationPage({
        items: Array.from({ length: 21 }, (_, n) => ({
          ...item,
          participantId: `9d400000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        })),
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("requests more with both cursor fields and treats 401 as login required", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      loadParticipantInvitationPage({
        fetch: fetcher,
        cursor: { invitedAt, id: participantId },
      }),
    ).resolves.toEqual({ status: "AUTH_REQUIRED" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/v1/me/job-participations/invitations?limit=20&beforeAt=2026-09-16T08%3A00%3A00.000Z&beforeId=${participantId}`,
    );
  });

  it("requires an explicit decision, CSRF, idempotency key and matching success state", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          state: "ACCEPTED",
          recordedAt: "2026-09-16T08:01:00.000Z",
        }),
      );
    await expect(
      sendParticipantDecision({
        fetch: fetcher,
        participantId,
        commandId,
        decision: "ACCEPT",
      }),
    ).resolves.toEqual({ status: "OK", state: "ACCEPTED" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/auth/csrf");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/job-participations/${participantId}/decision`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toEqual({
      body: JSON.stringify({ commandId, decision: "ACCEPT" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": "csrf-test",
      },
      method: "POST",
    });
  });

  it("does not treat a mismatched, leaked, or failed mutation response as acceptance", async () => {
    for (const body of [
      { status: "APPLIED", state: "DECLINED", recordedAt: invitedAt },
      {
        status: "APPLIED",
        state: "ACCEPTED",
        recordedAt: invitedAt,
        exactAddress: "private",
      },
      { status: "APPLIED", state: "ACCEPTED", recordedAt: "invalid" },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(
        sendParticipantDecision({
          fetch: fetcher,
          participantId,
          commandId,
          decision: "ACCEPT",
        }),
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(
      sendParticipantDecision({
        fetch: denied,
        participantId,
        commandId,
        decision: "ACCEPT",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });

  it("does not post when the CSRF response is malformed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ csrfToken: "csrf-test", unexpected: true }),
      );
    await expect(
      sendParticipantDecision({
        fetch: fetcher,
        participantId,
        commandId,
        decision: "DECLINE",
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
