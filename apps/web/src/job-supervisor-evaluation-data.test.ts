import { describe, expect, it, vi } from "vitest";

import {
  loadReceivedSupervisorEvaluations,
  loadSupervisorEvaluationDetail,
  loadSupervisorEvaluations,
  parseReceivedSupervisorEvaluationPage,
  parseSupervisorEvaluationPage,
  submitSupervisorEvaluation,
  supervisorEvaluationDimensions,
  type SupervisorEvaluationRatings,
  validSupervisorEvaluationDraft,
} from "./job-supervisor-evaluation-data";

const jobId = "95100000-0000-4000-8000-000000000001";
const participantId = "95100000-0000-4000-8000-000000000002";
const profileId = "95100000-0000-4000-8000-000000000003";
const evaluationId = "95100000-0000-4000-8000-000000000004";
const revisionId = "95100000-0000-4000-8000-000000000005";
const completedAt = "2026-09-01T10:00:00.000Z";
const deadline = "2026-09-15T10:00:00.000Z";
const requestUrl = (input: RequestInfo | URL) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const ratings = (value: 1 | 2 | 3 | 4 | 5 | null = 5) =>
  Object.fromEntries(
    supervisorEvaluationDimensions.map(([key]) => [key, value]),
  ) as SupervisorEvaluationRatings;

const ownEvaluation = () => ({
  evaluationId,
  revisionId,
  version: 1,
  submittedAt: "2026-09-02T10:00:00.000Z",
  revisedAt: "2026-09-02T10:00:00.000Z",
  editDeadline: "2026-09-02T11:00:00.000Z",
  ratings: ratings(),
  comment: "Vecné odborné hodnotenie.",
});

const page = () => ({
  jobId,
  completedAt,
  submissionDeadline: deadline,
  targets: [
    {
      participantId,
      participantProfileId: profileId,
      displayName: "Overený účastník",
      relationshipKind: "SITE_MANAGER",
      overlapStartedAt: "2026-08-20T08:00:00.000Z",
      overlapEndedAt: completedAt,
      verifiedProfessionCodes: ["TEST:MURAR"],
      verifiedRoles: ["MEMBER"],
      evaluation: ownEvaluation(),
    },
  ],
});

const receivedPage = () => ({
  jobId,
  evaluations: [
    {
      sourceType: "SUPERVISOR_EVALUATION",
      evaluationId,
      targetParticipantId: participantId,
      targetProfileId: profileId,
      evaluatorDisplayName: "Vedúci zákazky",
      relationshipKind: "SITE_MANAGER",
      overlapStartedAt: "2026-08-20T08:00:00.000Z",
      overlapEndedAt: completedAt,
      verifiedProfessionCodes: ["TEST:MURAR"],
      verifiedTargetRoles: ["MEMBER"],
      submittedAt: "2026-09-02T10:00:00.000Z",
      revisedAt: "2026-09-02T10:00:00.000Z",
      ratings: ratings(),
      comment: "Vecné odborné hodnotenie.",
    },
  ],
});

describe("private supervisor evaluation DTOs", () => {
  it("strictly parses eligible targets and received evaluations", () => {
    expect(
      parseSupervisorEvaluationPage(page(), jobId)?.targets[0],
    ).toMatchObject({
      participantId,
      relationshipKind: "SITE_MANAGER",
      verifiedProfessionCodes: ["TEST:MURAR"],
    });
    expect(
      parseReceivedSupervisorEvaluationPage(receivedPage(), jobId)
        ?.evaluations[0],
    ).toMatchObject({
      evaluatorDisplayName: "Vedúci zákazky",
      sourceType: "SUPERVISOR_EVALUATION",
    });
  });

  it("fails closed on extra fields, duplicate targets, invalid overlap and all-N/A ratings", () => {
    expect(
      parseSupervisorEvaluationPage({ ...page(), secret: "leak" }, jobId),
    ).toBeNull();
    expect(
      parseSupervisorEvaluationPage(
        { ...page(), targets: [page().targets[0], page().targets[0]] },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseSupervisorEvaluationPage(
        {
          ...page(),
          targets: [
            {
              ...page().targets[0],
              overlapEndedAt: "2026-08-19T08:00:00.000Z",
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseSupervisorEvaluationPage(
        {
          ...page(),
          targets: [
            {
              ...page().targets[0],
              evaluation: { ...ownEvaluation(), ratings: ratings(null) },
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
  });

  it("loads each private surface with no-store and rejects malformed payloads", async () => {
    const evaluatorFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(page()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(
      loadSupervisorEvaluations({ fetch: evaluatorFetch, jobId }),
    ).resolves.toMatchObject({ status: "OK" });
    expect(evaluatorFetch).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/supervisor-evaluations`,
      { cache: "no-store", credentials: "same-origin" },
    );

    const receivedFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(receivedPage()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(
      loadReceivedSupervisorEvaluations({ fetch: receivedFetch, jobId }),
    ).resolves.toMatchObject({ status: "OK" });
    expect(receivedFetch).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/supervisor-evaluations/received`,
      { cache: "no-store", credentials: "same-origin" },
    );

    const detailFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(receivedPage().evaluations[0]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(
      loadSupervisorEvaluationDetail({
        fetch: detailFetch,
        jobId,
        evaluationId,
      }),
    ).resolves.toMatchObject({
      status: "OK",
      evaluation: { evaluationId },
    });
    expect(detailFetch).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/supervisor-evaluations/${evaluationId}`,
      { cache: "no-store", credentials: "same-origin" },
    );

    const malformed = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ...page(), secret: true }), {
          status: 200,
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(
      loadSupervisorEvaluations({ fetch: malformed, jobId }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});

describe("supervisor evaluation commands", () => {
  it("rejects all-N/A locally and submits one exact CSRF-protected intent", async () => {
    expect(validSupervisorEvaluationDraft(ratings(null), "")).toBe(false);
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input) === "/v1/auth/csrf")
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
            status: 200,
          }),
        );
      expect(requestUrl(input)).toBe(
        `/v1/me/jobs/${jobId}/supervisor-evaluations/participants/${participantId}`,
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "x-csrf-token": "csrf-token" });
      expect(
        JSON.parse(typeof init?.body === "string" ? init.body : ""),
      ).toEqual({
        commandId: revisionId,
        expectedVersion: 0,
        ratings: ratings(),
        comment: null,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: "APPLIED",
            evaluationId,
            revisionId,
            version: 1,
            recordedAt: "2026-09-02T10:00:00.000Z",
          }),
          { status: 201 },
        ),
      );
    }) as unknown as typeof fetch;
    await expect(
      submitSupervisorEvaluation({
        fetch: fetcher,
        jobId,
        participantId,
        commandId: revisionId,
        expectedVersion: 0,
        ratings: ratings(),
        comment: "",
      }),
    ).resolves.toEqual({ status: "OK", outcome: "APPLIED", version: 1 });
  });

  it("maps stale and edit-window conflicts without accepting unknown codes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "STALE_VERSION" }), {
          status: 409,
        }),
      ) as unknown as typeof fetch;
    await expect(
      submitSupervisorEvaluation({
        fetch: fetcher,
        jobId,
        participantId,
        commandId: revisionId,
        expectedVersion: 0,
        ratings: ratings(),
        comment: "",
      }),
    ).resolves.toEqual({ status: "CONFLICT" });
  });
});
