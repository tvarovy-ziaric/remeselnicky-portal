import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  leaveParticipation,
  loadParticipationHistory,
  parseParticipationHistoryPage,
  participationCapabilityHref,
  ParticipantHistory,
} from "./participant-history";

const participantId = "9d400000-0000-4000-8000-000000000011";
const jobId = "9d400000-0000-4000-8000-000000000012";
const commandId = "9d400000-0000-4000-8000-000000000013";
const invitedAt = "2026-09-16T08:00:00.000Z";
const acceptedAt = "2026-09-16T09:00:00.000Z";
const item = {
  participantId,
  jobId,
  providerDisplayName: "Majster Test",
  municipalityName: "Bratislava",
  primaryProfessionCode: "PROF:ELECTRICIAN",
  invitedAt,
  acceptedAt,
  leftAt: null,
  jobState: "IN_PROGRESS",
  state: "ACCEPTED",
};

describe("own Job participation history", () => {
  it("renders no private history before the authorized fetch", () => {
    const html = renderToStaticMarkup(<ParticipantHistory />);
    expect(html).toContain("Načítavam vašu históriu");
    expect(html).not.toContain("Majster Test");
  });

  it("links only accepted or historical own participation to its capability record", () => {
    expect(participationCapabilityHref(item as never)).toBe(
      `/ucasti/schopnosti/${participantId}`,
    );
    expect(
      participationCapabilityHref({
        ...item,
        state: "LEFT",
        leftAt: acceptedAt,
      } as never),
    ).toBe(`/ucasti/schopnosti/${participantId}`);
    expect(
      participationCapabilityHref({
        ...item,
        state: "DECLINED",
        acceptedAt: null,
      } as never),
    ).toBeNull();
  });

  it("accepts only the bounded own-history projection", async () => {
    const payload = {
      items: [item],
      nextCursor: { invitedAt, id: participantId },
    };
    expect(parseParticipationHistoryPage(payload)).toEqual(payload);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(payload));
    await expect(loadParticipationHistory({ fetch: fetcher })).resolves.toEqual(
      {
        status: "OK",
        page: payload,
      },
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/me/job-participations/history?limit=20",
      { cache: "no-store", credentials: "same-origin" },
    );
  });

  it("rejects leaked contact/address, invalid intervals, duplicates and corrupt cursor", () => {
    for (const extra of ["exactAddress", "customerContact", "reason"]) {
      expect(
        parseParticipationHistoryPage({
          items: [{ ...item, [extra]: "private" }],
          nextCursor: null,
        }),
      ).toBeNull();
    }
    for (const broken of [
      { ...item, state: "ACCEPTED", acceptedAt: null },
      { ...item, state: "INVITED" },
      { ...item, jobState: "UNKNOWN" },
      { ...item, state: "LEFT", leftAt: null },
      { ...item, acceptedAt: "2026-09-15T09:00:00.000Z" },
      { ...item, leftAt: "2026-09-16T08:30:00.000Z", state: "LEFT" },
    ])
      expect(
        parseParticipationHistoryPage({ items: [broken], nextCursor: null }),
      ).toBeNull();
    expect(
      parseParticipationHistoryPage({ items: [item, item], nextCursor: null }),
    ).toBeNull();
    expect(
      parseParticipationHistoryPage({
        items: [item],
        nextCursor: { invitedAt, id: jobId },
      }),
    ).toBeNull();
  });

  it("keeps history private and uses both cursor fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      loadParticipationHistory({
        fetch: fetcher,
        cursor: { invitedAt, id: participantId },
      }),
    ).resolves.toEqual({ status: "AUTH_REQUIRED" });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `/v1/me/job-participations/history?limit=20&beforeAt=2026-09-16T08%3A00%3A00.000Z&beforeId=${participantId}`,
    );
  });

  it("requires a CSRF-protected own LEAVE command with exact success shape", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          state: "LEFT",
          recordedAt: acceptedAt,
        }),
      );
    await expect(
      leaveParticipation({ fetch: fetcher, participantId, commandId }),
    ).resolves.toBe("OK");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/v1/me/job-participations/${participantId}/decision`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toEqual({
      body: JSON.stringify({ commandId, decision: "LEAVE" }),
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

  it("does not infer departure from a malformed or leaked response", async () => {
    for (const bad of [
      { status: "APPLIED", state: "REMOVED", recordedAt: acceptedAt },
      {
        status: "APPLIED",
        state: "LEFT",
        recordedAt: acceptedAt,
        reason: "private",
      },
      { status: "APPLIED", state: "LEFT", recordedAt: "bad" },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-test" }))
        .mockResolvedValueOnce(Response.json(bad));
      await expect(
        leaveParticipation({ fetch: fetcher, participantId, commandId }),
      ).resolves.toBe("UNAVAILABLE");
    }
  });
});
