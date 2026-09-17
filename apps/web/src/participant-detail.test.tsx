import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  loadJobParticipantDetail,
  parseJobParticipantDetail,
  ParticipantDetail,
} from "./participant-detail";

const participantId = "9d400000-0000-4000-8000-000000000011";
const jobId = "9d400000-0000-4000-8000-000000000012";
const detail = {
  participantId,
  jobId,
  viewerRole: "PARTICIPANT",
  state: "INVITED",
  jobState: "CONFIRMED",
  participantDisplayName: "Pomocník",
  providerDisplayName: "Majster",
  municipalityName: "Bratislava",
  primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
  invitedAt: "2026-09-16T08:00:00.000Z",
  acceptedAt: null,
  leftAt: null,
  canDecide: true,
  canLeave: false,
};

describe("private Job participation detail", () => {
  it("does not render private data or actions before the authorized read", () => {
    for (const context of ["INVITATION", "HISTORY", "JOB_PARTY"] as const) {
      const html = renderToStaticMarkup(
        <ParticipantDetail
          participantId={participantId}
          context={context}
          jobId={jobId}
        />,
      );
      expect(html).toContain("Načítavam účasť");
      expect(html).not.toContain("Pomocník");
      expect(html).not.toContain("Prijať účasť");
    }
  });

  it("loads only the exact private projection through the same-origin session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(detail));
    expect(parseJobParticipantDetail(detail)).toEqual(detail);
    await expect(
      loadJobParticipantDetail({ fetch: fetcher, participantId }),
    ).resolves.toEqual({ status: "OK", detail });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/job-participations/${participantId}`,
      { cache: "no-store", credentials: "same-origin" },
    );
  });

  it("rejects extra private fields, invalid lifecycle dates and privilege claims", () => {
    for (const field of ["exactAddress", "customerContact", "reason"]) {
      expect(
        parseJobParticipantDetail({ ...detail, [field]: "private" }),
      ).toBeNull();
    }
    for (const invalid of [
      { ...detail, participantId: "not-a-uuid" },
      { ...detail, acceptedAt: detail.invitedAt },
      { ...detail, state: "LEFT", acceptedAt: detail.invitedAt },
      { ...detail, viewerRole: "CUSTOMER" },
      { ...detail, viewerRole: "PRIMARY_PROVIDER" },
      { ...detail, jobState: "CANCELLED" },
      { ...detail, canLeave: true },
      { ...detail, participantDisplayName: "<script>" + "\u0000" },
    ])
      expect(parseJobParticipantDetail(invalid)).toBeNull();
  });

  it("denies invalid ids before fetching and does not reveal denied resources", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      loadJobParticipantDetail({ fetch: fetcher, participantId: "bad" }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      loadJobParticipantDetail({ fetch: fetcher, participantId }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    fetcher.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      loadJobParticipantDetail({ fetch: fetcher, participantId }),
    ).resolves.toEqual({ status: "AUTH_REQUIRED" });
  });
});
