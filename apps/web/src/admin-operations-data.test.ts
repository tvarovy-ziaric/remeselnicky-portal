import { describe, expect, it, vi } from "vitest";

import {
  accessAdminDispute,
  loadAdminDisputeQueue,
  parseAdminDisputeDetail,
  parseAdminDisputeQueue,
  sendAdminDisputeCommand,
  sendAdminJobCorrection,
} from "./admin-operations-data";

const disputeId = "a9800000-0000-4000-8000-000000000001";
const jobId = "a9800000-0000-4000-8000-000000000002";
const commandId = "a9800000-0000-4000-8000-000000000003";
const conversationId = "a9800000-0000-4000-8000-000000000004";
const item = {
  disputeId,
  jobId,
  category: "QUALITY_DEFECT",
  state: "UNDER_REVIEW",
  openedByRole: "CUSTOMER",
  createdAt: "2026-09-24T10:00:00.000Z",
  stateChangedAt: "2026-09-24T10:10:00.000Z",
  informationRequestCount: 1,
} as const;
const detail = {
  ...item,
  description: "Opravená časť strechy stále zateká.",
  desiredResolution: "Odstrániť zatekanie.",
  jobState: "IN_PROGRESS",
  conversationId,
  statements: [
    {
      id: commandId,
      authorRole: "CUSTOMER",
      kind: "STATEMENT",
      body: "Fotografia zachytáva miesto zatekania.",
      createdAt: "2026-09-24T10:01:00.000Z",
    },
  ],
  evidence: [],
  informationRequests: [
    {
      id: commandId,
      recipient: "PRIMARY_PROVIDER",
      requestText: "Doplňte fotografiu opraveného detailu.",
      replyDeadline: "2026-09-30T10:00:00.000Z",
      requestedAt: "2026-09-24T10:11:00.000Z",
    },
  ],
  internalNotes: [],
  outcomes: [],
  conversation: [],
  attachments: [],
};

describe("admin operations response boundary", () => {
  it("accepts only the exact bounded queue projection", () => {
    expect(parseAdminDisputeQueue({ items: [item] })).toEqual([item]);
    expect(
      parseAdminDisputeQueue({ items: [{ ...item, privateReason: "leak" }] }),
    ).toBeNull();
    expect(
      parseAdminDisputeQueue({
        items: [{ ...item, informationRequestCount: -1 }],
      }),
    ).toBeNull();
  });

  it("validates all audited detail collections and their request count", () => {
    expect(parseAdminDisputeDetail({ detail })?.conversationId).toBe(
      conversationId,
    );
    expect(
      parseAdminDisputeDetail({
        detail: { ...detail, informationRequestCount: 0 },
      }),
    ).toBeNull();
    expect(
      parseAdminDisputeDetail({
        detail: {
          ...detail,
          internalNotes: [{ id: commandId, body: "", createdAt: "invalid" }],
        },
      }),
    ).toBeNull();
  });
});

describe("admin operations transport", () => {
  it("filters the dispute queue without caching", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [item] }));
    await expect(
      loadAdminDisputeQueue(fetcher, "UNDER_REVIEW"),
    ).resolves.toMatchObject({ status: "OK" });
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/admin/disputes?state=UNDER_REVIEW",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("puts the sensitive-access purpose in an audited POST body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token-123456" }))
      .mockResolvedValueOnce(Response.json({ detail }));
    const result = await accessAdminDispute(fetcher, {
      disputeId,
      accessId: commandId,
      reason: "Preverenie komunikácie k otvorenému sporu.",
    });
    expect(result.status).toBe("OK");
    const [path, options] = fetcher.mock.calls[1] ?? [];
    expect(path).toBe(`/v1/admin/disputes/${disputeId}/access`);
    expect(options).toMatchObject({ method: "POST", cache: "no-store" });
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe(
      "csrf-token-123456",
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      accessId: commandId,
      reason: "Preverenie komunikácie k otvorenému sporu.",
    });
  });

  it("uses a named dispute command and preserves expected-state CAS", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token-123456" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          commandId,
          disputeId,
          state: "WAITING_FOR_PARTY",
          recordedAt: "2026-09-24T10:20:00.000Z",
        }),
      );
    await expect(
      sendAdminDisputeCommand(fetcher, {
        disputeId,
        commandId,
        expectedState: "UNDER_REVIEW",
        reason: "Chýbajú podklady od hlavného remeselníka.",
        command: {
          action: "REQUEST_INFORMATION",
          recipient: "PRIMARY_PROVIDER",
          requestText: "Doplňte fotografiu opraveného detailu.",
          replyDeadline: null,
        },
      }),
    ).resolves.toMatchObject({ status: "OK", state: "WAITING_FOR_PARTY" });
    const [path, options] = fetcher.mock.calls[1] ?? [];
    expect(path).toBe(`/v1/admin/disputes/${disputeId}/request-information`);
    expect(JSON.parse(String(options?.body))).toEqual({
      commandId,
      expectedState: "UNDER_REVIEW",
      reason: "Chýbajú podklady od hlavného remeselníka.",
      recipient: "PRIMARY_PROVIDER",
      requestText: "Doplňte fotografiu opraveného detailu.",
      replyDeadline: null,
    });
  });

  it("keeps force-complete and force-cancel as distinct commands", async () => {
    const complete = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token-123456" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          commandId,
          jobState: "COMPLETED",
          recordedAt: "2026-09-24T10:30:00.000Z",
        }),
      );
    await sendAdminJobCorrection(complete, {
      kind: "COMPLETE",
      commandId,
      jobId,
      expectedState: "IN_PROGRESS",
      reason: "Dokončenie preukázané podkladmi oboch strán.",
    });
    expect(complete.mock.calls[1]?.[0]).toBe(
      `/v1/admin/jobs/${jobId}/force-complete`,
    );

    const cancel = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token-123456" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "APPLIED",
          commandId,
          jobState: "CANCELLED",
          recordedAt: "2026-09-24T10:31:00.000Z",
        }),
      );
    await sendAdminJobCorrection(cancel, {
      kind: "CANCEL",
      commandId,
      jobId,
      expectedState: "IN_PROGRESS",
      reason: "Bezpečnostný dôvod vyžaduje ukončenie zákazky.",
      userFacingReason: "Platforma zákazku z bezpečnostných dôvodov zrušila.",
    });
    expect(cancel.mock.calls[1]?.[0]).toBe(
      `/v1/admin/jobs/${jobId}/force-cancel`,
    );
    expect(JSON.parse(String(cancel.mock.calls[1]?.[1]?.body))).toMatchObject({
      userFacingReason: "Platforma zákazku z bezpečnostných dôvodov zrušila.",
    });
  });
});
