import { describe, expect, it, vi } from "vitest";

import {
  addJobDisputeEvidence,
  confirmJobDisputeSettlement,
  loadJobDispute,
  loadJobDisputes,
  loadJobDisputeUploadStatus,
  openJobDispute,
  parseJobDisputeDetail,
  parseJobDisputeList,
  uploadJobDisputeEvidence,
  withdrawJobDispute,
} from "./job-dispute-data";

const jobId = "98000000-0000-4000-8000-000000000001";
const disputeId = "98000000-0000-4000-8000-000000000002";
const statementId = "98000000-0000-4000-8000-000000000003";
const evidenceId = "98000000-0000-4000-8000-000000000004";
const mediaAssetId = "98000000-0000-4000-8000-000000000005";
const quoteId = "98000000-0000-4000-8000-000000000006";
const changeOrderId = "98000000-0000-4000-8000-000000000007";
const revisionId = "98000000-0000-4000-8000-000000000008";
const eventId = "98000000-0000-4000-8000-000000000009";
const commandId = "98000000-0000-4000-8000-000000000010";

const summary = () => ({
  id: disputeId,
  jobId,
  openedByRole: "CUSTOMER",
  viewerRole: "PRIMARY_PROVIDER",
  category: "QUALITY_DEFECT",
  description: "Opravená časť strechy stále zateká.",
  desiredResolution: "Odstrániť zatekanie.",
  state: "OPEN",
  stateRevision: 1,
  createdAt: "2026-09-24T10:00:00.000Z",
  stateChangedAt: "2026-09-24T10:00:00.000Z",
  canAddContent: true,
  canWithdraw: false,
});

const detail = () => ({
  ...summary(),
  statements: [
    {
      id: statementId,
      authorRole: "CUSTOMER",
      kind: "STATEMENT",
      body: "Vada je viditeľná na priloženej fotografii.",
      createdAt: "2026-09-24T10:01:00.000Z",
    },
  ],
  evidence: [
    {
      id: evidenceId,
      submittedByRole: "CUSTOMER",
      source: "NEW_UPLOAD",
      mediaAssetId,
      kind: "PHOTO",
      description: "Miesto zatekania po daždi.",
      displayFilename: null,
      contentType: "image/webp",
      downloadPath: `/v1/media/${mediaAssetId}/download`,
      createdAt: "2026-09-24T10:02:00.000Z",
    },
  ],
  adminRequests: [
    {
      id: commandId,
      recipient: "PRIMARY_PROVIDER",
      requestText: "Doplňte fotografiu opraveného detailu.",
      replyDeadline: "2026-09-30T10:00:00.000Z",
      requestedAt: "2026-09-24T11:00:00.000Z",
    },
  ],
  outcome: {
    id: revisionId,
    category: "OPERATIONAL_ADMIN_RESOLUTION",
    basis: "ADMINISTRATIVE_CLOSURE",
    summary: "Strany dostali odporúčanie na zdokumentovanú opravu.",
    recordedAt: "2026-09-24T12:00:00.000Z",
  },
  settlementConfirmations: [
    {
      id: commandId,
      confirmedByRole: "CUSTOMER",
      summary: "Strany sa dohodli na zdokumentovanej oprave.",
      confirmedAt: "2026-09-24T11:30:00.000Z",
    },
  ],
  caseTimeline: [
    {
      eventId: disputeId,
      action: "OPEN",
      fromState: null,
      toState: "OPEN",
      occurredAt: "2026-09-24T10:00:00.000Z",
    },
  ],
  commercialBaseline: {
    acceptedRequestContentRevision: 2,
    acceptedRequestVisibleVersion: 3,
    acceptedQuoteId: quoteId,
    acceptedQuoteRevision: 4,
    acceptedQuoteMode: "EXTERNAL_PDF",
    acceptedQuotePdfDownloadPath: `/v1/media/${quoteId}/download`,
    approvedChanges: [
      {
        changeOrderId,
        revisionId,
        revisionNumber: 1,
        title: "Dodatočné oplechovanie",
        changeDescription: "Oplechovanie komína.",
        approvedAt: "2026-09-24T09:00:00.000Z",
      },
    ],
    jobDashboardPath: `/zakazky/${jobId}`,
  },
  jobTimeline: [
    {
      eventId,
      eventType: "JOB_CONFIRMED",
      occurredAt: "2026-09-20T10:00:00.000Z",
    },
  ],
});

function path(input: RequestInfo | URL) {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

describe("D22 private dispute web contract", () => {
  it("accepts the exact case projection and immutable Job evidence", () => {
    expect(parseJobDisputeList({ items: [summary()] }, jobId)).toHaveLength(1);
    const parsed = parseJobDisputeDetail(detail(), jobId, disputeId);
    expect(parsed?.viewerRole).toBe("PRIMARY_PROVIDER");
    expect(parsed?.commercialBaseline.approvedChanges[0]?.revisionId).toBe(
      revisionId,
    );
    expect(parsed?.evidence[0]?.downloadPath).toBe(
      `/v1/media/${mediaAssetId}/download`,
    );
    expect(parsed?.adminRequests[0]?.recipient).toBe("PRIMARY_PROVIDER");
    expect(parsed?.outcome?.category).toBe("OPERATIONAL_ADMIN_RESOLUTION");
  });

  it("fails closed on cross-Job identity, state/content mismatch and unsafe evidence", () => {
    expect(
      parseJobDisputeList({ items: [{ ...summary(), jobId: quoteId }] }, jobId),
    ).toBeNull();
    expect(
      parseJobDisputeList(
        { items: [{ ...summary(), state: "CLOSED", canAddContent: true }] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobDisputeDetail(
        {
          ...detail(),
          evidence: [
            {
              ...detail().evidence[0],
              downloadPath: "https://evil.test/private",
            },
          ],
        },
        jobId,
        disputeId,
      ),
    ).toBeNull();
    expect(
      parseJobDisputeDetail(
        {
          ...detail(),
          commercialBaseline: {
            ...detail().commercialBaseline,
            jobDashboardPath: `/zakazky/${quoteId}`,
          },
        },
        jobId,
        disputeId,
      ),
    ).toBeNull();
    expect(
      parseJobDisputeDetail(
        { ...detail(), leakedAdminNote: "never" },
        jobId,
        disputeId,
      ),
    ).toBeNull();
  });

  it("loads only private no-store case routes and rejects malformed responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ items: [summary()] }))
      .mockResolvedValueOnce(Response.json(detail()));
    expect(await loadJobDisputes({ fetch: fetcher, jobId })).toMatchObject({
      status: "OK",
    });
    expect(
      await loadJobDispute({ fetch: fetcher, jobId, disputeId }),
    ).toMatchObject({
      status: "OK",
    });
    expect(fetcher.mock.calls.map(([input]) => path(input))).toEqual([
      `/v1/me/jobs/${jobId}/disputes`,
      `/v1/me/jobs/${jobId}/disputes/${disputeId}`,
    ]);
    expect(
      fetcher.mock.calls.every(
        ([, options]) =>
          options?.cache === "no-store" &&
          options.credentials === "same-origin",
      ),
    ).toBe(true);
    const malformed = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ items: [{ ...summary(), secret: "leak" }] }),
      ),
    );
    expect(await loadJobDisputes({ fetch: malformed, jobId })).toEqual({
      status: "UNAVAILABLE",
    });
  });

  it("sends strict CSRF-protected idempotent commands and maps conflicts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "APPLIED",
            id: disputeId,
            disputeId,
            occurredAt: "2026-09-24T10:00:00.000Z",
          },
          { status: 201 },
        ),
      );
    const result = await openJobDispute({
      fetch: fetcher,
      jobId,
      commandId,
      category: "QUALITY_DEFECT",
      description: "Opravená časť strechy stále zateká.",
      desiredResolution: "Odstrániť zatekanie.",
    });
    expect(result).toMatchObject({
      status: "OK",
      outcome: "APPLIED",
      disputeId,
    });
    const [, options] = fetcher.mock.calls[1] ?? [];
    expect(options?.method).toBe("POST");
    expect(options?.credentials).toBe("same-origin");
    expect((options?.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "csrf-token",
    );
    expect(typeof options?.body).toBe("string");
    if (typeof options?.body !== "string") return;
    expect(JSON.parse(options.body) as unknown).toEqual({
      commandId,
      category: "QUALITY_DEFECT",
      description: "Opravená časť strechy stále zateká.",
      desiredResolution: "Odstrániť zatekanie.",
    });

    const conflict = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json({ code: "DUPLICATE_EVIDENCE" }, { status: 409 }),
      );
    expect(
      await addJobDisputeEvidence({
        fetch: conflict,
        jobId,
        disputeId,
        commandId,
        source: "EXISTING_JOB_EVIDENCE",
        mediaAssetId,
        description: "Už priložený dôkaz.",
      }),
    ).toEqual({ status: "DUPLICATE_EVIDENCE" });
  });

  it("sends only the exact withdrawal and settlement command bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "APPLIED",
            id: commandId,
            disputeId,
            occurredAt: "2026-09-24T10:00:00.000Z",
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json(
          {
            status: "APPLIED",
            id: commandId,
            disputeId,
            occurredAt: "2026-09-24T10:01:00.000Z",
          },
          { status: 201 },
        ),
      );
    await expect(
      withdrawJobDispute({
        fetch: fetcher,
        jobId,
        disputeId,
        commandId,
        reason: "Prípad už nechcem ďalej viesť.",
      }),
    ).resolves.toMatchObject({ status: "OK", outcome: "APPLIED" });
    const settlementSummary =
      "Obe strany zaznamenávajú opravu do piatich pracovných dní.";
    await expect(
      confirmJobDisputeSettlement({
        fetch: fetcher,
        jobId,
        disputeId,
        commandId,
        summary: settlementSummary,
      }),
    ).resolves.toMatchObject({ status: "OK", outcome: "APPLIED" });
    const withdrawalCall = fetcher.mock.calls[1];
    const settlementCall = fetcher.mock.calls[3];
    expect(withdrawalCall && path(withdrawalCall[0])).toBe(
      `/v1/me/jobs/${jobId}/disputes/${disputeId}/withdrawal`,
    );
    expect(settlementCall && path(settlementCall[0])).toBe(
      `/v1/me/jobs/${jobId}/disputes/${disputeId}/settlement-confirmations`,
    );
    expect(
      typeof withdrawalCall?.[1]?.body === "string"
        ? JSON.parse(withdrawalCall[1].body)
        : null,
    ).toEqual({ commandId, reason: "Prípad už nechcem ďalej viesť." });
    expect(
      typeof settlementCall?.[1]?.body === "string"
        ? JSON.parse(settlementCall[1].body)
        : null,
    ).toEqual({ commandId, summary: settlementSummary });
  });

  it("uploads only supported private binaries and validates processing status", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "csrf-token" }))
      .mockResolvedValueOnce(
        Response.json(
          { assetId: mediaAssetId, kind: "PDF", status: "PROCESSING" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ status: "READY", canBind: true }));
    const file = new File([new Uint8Array([37, 80, 68, 70])], "doklad.pdf", {
      type: "application/pdf",
    });
    expect(
      await uploadJobDisputeEvidence({
        fetch: fetcher,
        jobId,
        disputeId,
        file,
      }),
    ).toEqual({ status: "OK", assetId: mediaAssetId, kind: "PDF" });
    const [, uploadOptions] = fetcher.mock.calls[1] ?? [];
    expect(uploadOptions?.body).toBe(file);
    expect(
      (uploadOptions?.headers as Record<string, string>)["content-type"],
    ).toBe("application/pdf");
    expect(
      await loadJobDisputeUploadStatus({
        fetch: fetcher,
        jobId,
        disputeId,
        mediaAssetId,
      }),
    ).toEqual({ status: "OK", value: { status: "READY", canBind: true } });

    const invalid = new File(["x"], "script.svg", { type: "image/svg+xml" });
    expect(
      await uploadJobDisputeEvidence({
        fetch: fetcher,
        jobId,
        disputeId,
        file: invalid,
      }),
    ).toEqual({ status: "INVALID_FILE" });
  });
});
