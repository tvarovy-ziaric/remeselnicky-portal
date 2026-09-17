import { describe, expect, it, vi } from "vitest";

import {
  loadCompletionPage,
  parseCompletionPage,
  sendCompletionCommand,
  validCompletionCommand,
} from "./job-completion-data";

const jobId = "89600000-0000-4000-8000-000000000002";
const attemptId = "89600000-0000-4000-8000-000000000003";
const commandId = "89600000-0000-4000-8000-000000000004";
const mediaId = "89600000-0000-4000-8000-000000000005";
const attempt = {
  id: attemptId,
  attemptNumber: 1,
  requestedAt: "2026-09-17T09:00:00.000Z",
  note: "Dielo je hotové",
  physicalWorkFinishedOn: "2026-09-16",
  finalMediaDownloadPaths: [`/v1/media/${mediaId}/download`],
  outcome: "PENDING",
  decidedAt: null,
  rejectionCategory: null,
  rejectionReason: null,
  objectionMediaDownloadPaths: [],
};
const page = { jobState: "COMPLETION_REQUESTED", attempts: [attempt] };

describe("private completion client", () => {
  it("accepts chronological provenance and rejects leaked fields or impossible outcomes", () => {
    expect(parseCompletionPage(page)).not.toBeNull();
    expect(parseCompletionPage({ ...page, paymentStatus: "PAID" })).toBeNull();
    expect(
      parseCompletionPage({
        ...page,
        attempts: [{ ...attempt, requestedByUserId: jobId }],
      }),
    ).toBeNull();
    expect(
      parseCompletionPage({
        ...page,
        attempts: [
          {
            ...attempt,
            finalMediaDownloadPaths: ["https://external.test/file"],
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseCompletionPage({
        ...page,
        attempts: [{ ...attempt, outcome: "ACCEPTED", decidedAt: null }],
      }),
    ).toBeNull();
    expect(parseCompletionPage({ ...page, jobState: "COMPLETED" })).toBeNull();
    const administrativeCompletion = {
      commandId,
      recordedAt: "2026-09-17T10:00:00.000Z",
      reason: "Výnimočné uzavretie po kontrole zákazky.",
    };
    expect(
      parseCompletionPage({
        ...page,
        jobState: "COMPLETED",
        administrativeCompletion,
      }),
    ).toMatchObject({ administrativeCompletion });
    expect(
      parseCompletionPage({
        ...page,
        jobState: "COMPLETED",
        administrativeCompletion: {
          ...administrativeCompletion,
          payment: true,
        },
      }),
    ).toBeNull();
    const accepted = {
      ...attempt,
      outcome: "ACCEPTED",
      decidedAt: "2026-09-17T10:00:00.000Z",
    };
    expect(
      parseCompletionPage({ jobState: "COMPLETED", attempts: [accepted] }),
    ).not.toBeNull();
    expect(
      parseCompletionPage({
        jobState: "IN_PROGRESS",
        attempts: [
          {
            ...attempt,
            outcome: "REJECTED",
            decidedAt: accepted.decidedAt,
            rejectionCategory: "DEFECT",
            rejectionReason: "Treba opraviť práce",
          },
        ],
      }),
    ).not.toBeNull();
  });

  it("loads only the exact private Job page and fails closed", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(page)),
    );
    expect(await loadCompletionPage({ fetch: fetcher, jobId })).toMatchObject({
      status: "OK",
      page,
    });
    expect(fetcher).toHaveBeenCalledWith(`/v1/me/jobs/${jobId}/completion`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(
      (await loadCompletionPage({ fetch: fetcher, jobId: "bad" })).status,
    ).toBe("UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires valid media/date and sends exact CSRF-protected commands", async () => {
    expect(
      validCompletionCommand({
        kind: "REQUEST",
        finalMediaAssetIds: [mediaId],
      }),
    ).toBe(true);
    expect(
      validCompletionCommand({
        kind: "REQUEST",
        finalMediaAssetIds: [mediaId, mediaId],
      }),
    ).toBe(false);
    expect(
      validCompletionCommand({
        kind: "REQUEST",
        physicalWorkFinishedOn: "2026-02-30",
      }),
    ).toBe(false);
    expect(
      validCompletionCommand({
        kind: "REJECT",
        attemptId,
        category: "DEFECT",
        reason: "short",
      }),
    ).toBe(false);
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      if (input === "/v1/auth/csrf")
        return Promise.resolve(Response.json({ csrfToken: "private-csrf" }));
      expect(input).toBe(`/v1/me/jobs/${jobId}/completion/${attemptId}/reject`);
      expect(init?.headers).toMatchObject({ "x-csrf-token": "private-csrf" });
      if (typeof init?.body !== "string")
        throw new Error("JSON command body missing");
      expect(JSON.parse(init.body) as unknown).toEqual({
        commandId,
        category: "DEFECT",
        reason: "Treba opraviť práce",
        evidenceMediaAssetIds: [mediaId],
      });
      return Promise.resolve(
        Response.json(
          {
            status: "APPLIED",
            jobState: "IN_PROGRESS",
            attemptId,
            recordedAt: "2026-09-17T10:00:00.000Z",
          },
          { status: 201 },
        ),
      );
    });
    expect(
      await sendCompletionCommand({
        fetch: fetcher,
        jobId,
        commandId,
        command: {
          kind: "REJECT",
          attemptId,
          category: "DEFECT",
          reason: "Treba opraviť práce",
          evidenceMediaAssetIds: [mediaId],
        },
      }),
    ).toEqual({ status: "OK", jobState: "IN_PROGRESS", attemptId });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
