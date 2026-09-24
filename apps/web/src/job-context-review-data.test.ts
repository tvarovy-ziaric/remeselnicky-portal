import { describe, expect, it, vi } from "vitest";

import {
  loadJobContextReviews,
  parseJobContextReviewPage,
  participantReviewDimensions,
  type JobContextReviewRatings,
  submitJobContextReview,
  validJobContextReviewDraft,
  workGroupReviewDimensions,
} from "./job-context-review-data";

const jobId = "94100000-0000-4000-8000-000000000001";
const participantId = "94100000-0000-4000-8000-000000000002";
const participantProfileId = "94100000-0000-4000-8000-000000000003";
const workGroupId = "94100000-0000-4000-8000-000000000004";
const assignmentId = "94100000-0000-4000-8000-000000000005";
const revisionId = "94100000-0000-4000-8000-000000000006";
const commandId = "94100000-0000-4000-8000-000000000007";

const ratings = (dimensions: readonly (readonly [string, string])[]) =>
  Object.fromEntries(
    dimensions.map(([key], index) => [key, index === 0 ? 4 : null]),
  ) as JobContextReviewRatings;

function page() {
  return {
    jobId,
    completedAt: "2026-09-20T08:00:00.000Z",
    submissionDeadline: "2026-10-04T08:00:00.000Z",
    participants: [
      {
        targetKind: "PARTICIPANT",
        participantId,
        participantProfileId,
        displayName: "Marek K.",
        participationStartedAt: "2026-09-18T08:00:00.000Z",
        participationEndedAt: "2026-09-20T08:00:00.000Z",
        verifiedProfessionCodes: ["PROF:ROOFING"],
        verifiedRoles: ["MEMBER", "LEAD"],
        review: null,
      },
    ],
    workGroups: [
      {
        targetKind: "WORK_GROUP",
        workGroupId,
        name: "Strešná skupina",
        members: [
          {
            assignmentId,
            participantId,
            participantProfileId,
            displayName: "Marek K.",
            overlapStartedAt: "2026-09-18T09:00:00.000Z",
            overlapEndedAt: "2026-09-19T16:00:00.000Z",
          },
        ],
        review: {
          revisionId,
          version: 1,
          submittedAt: "2026-09-20T08:10:00.000Z",
          revisedAt: "2026-09-20T08:10:00.000Z",
          editDeadline: "2026-09-20T09:10:00.000Z",
          ratings: ratings(workGroupReviewDimensions),
          comment: "Vecné hodnotenie skupiny.",
        },
      },
    ],
  };
}

describe("secondary Job review private DTO", () => {
  it("strictly parses verified participants, historical work-group members, and target-specific reviews", () => {
    const parsed = parseJobContextReviewPage(page(), jobId);
    expect(parsed?.participants[0]).toMatchObject({
      targetKind: "PARTICIPANT",
      participantId,
      verifiedProfessionCodes: ["PROF:ROOFING"],
      verifiedRoles: ["MEMBER", "LEAD"],
    });
    expect(parsed?.workGroups[0]?.members).toEqual([
      expect.objectContaining({ assignmentId, participantId }),
    ]);
    expect(parsed?.workGroups[0]?.review?.ratings).toEqual(
      ratings(workGroupReviewDimensions),
    );
  });

  it("fails closed for extra fields, wrong dimensions, all-N/A, duplicate provenance, and invalid history", () => {
    expect(
      parseJobContextReviewPage({ ...page(), secret: "leak" }, jobId),
    ).toBeNull();
    expect(
      parseJobContextReviewPage({ ...page(), jobId: workGroupId }, jobId),
    ).toBeNull();
    expect(
      parseJobContextReviewPage(
        {
          ...page(),
          workGroups: [
            {
              ...page().workGroups[0],
              review: {
                ...page().workGroups[0]?.review,
                ratings: ratings(participantReviewDimensions),
              },
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobContextReviewPage(
        {
          ...page(),
          workGroups: [
            {
              ...page().workGroups[0],
              review: {
                ...page().workGroups[0]?.review,
                revisedAt: "2026-09-20T09:20:00.000Z",
              },
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobContextReviewPage(
        {
          ...page(),
          workGroups: [
            {
              ...page().workGroups[0],
              review: {
                ...page().workGroups[0]?.review,
                ratings: Object.fromEntries(
                  workGroupReviewDimensions.map(([key]) => [key, null]),
                ),
              },
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobContextReviewPage(
        {
          ...page(),
          participants: [page().participants[0], page().participants[0]],
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobContextReviewPage(
        {
          ...page(),
          workGroups: [
            {
              ...page().workGroups[0],
              members: [
                {
                  ...page().workGroups[0]?.members[0],
                  overlapEndedAt: "2026-09-21T08:00:00.000Z",
                },
              ],
            },
          ],
        },
        jobId,
      ),
    ).toBeNull();
  });

  it("loads with a private no-store request and distinguishes auth, hidden eligibility, and unsafe payloads", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(page())),
    );
    await expect(
      loadJobContextReviews({ fetch: fetcher, jobId }),
    ).resolves.toMatchObject({
      status: "OK",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/me/jobs/${jobId}/reviews/secondary`,
      { cache: "no-store", credentials: "same-origin" },
    );
    await expect(
      loadJobContextReviews({
        fetch: vi.fn(() =>
          Promise.resolve(new Response(null, { status: 401 })),
        ),
        jobId,
      }),
    ).resolves.toEqual({ status: "AUTH_REQUIRED" });
    await expect(
      loadJobContextReviews({
        fetch: vi.fn(() =>
          Promise.resolve(new Response(null, { status: 404 })),
        ),
        jobId,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    await expect(
      loadJobContextReviews({
        fetch: vi.fn(() =>
          Promise.resolve(Response.json({ ...page(), extra: true })),
        ),
        jobId,
      }),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});

describe("secondary Job review commands", () => {
  it("rejects all-N/A locally and posts exact participant and work-group intents with CSRF", async () => {
    expect(
      validJobContextReviewDraft(
        "PARTICIPANT",
        Object.fromEntries(
          participantReviewDimensions.map(([key]) => [key, null]),
        ),
        "",
      ),
    ).toBe(false);
    for (const [targetKind, targetId, dimensions, segment] of [
      [
        "PARTICIPANT",
        participantId,
        participantReviewDimensions,
        "participants",
      ],
      ["WORK_GROUP", workGroupId, workGroupReviewDimensions, "work-groups"],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>((input, init) => {
        if (input === "/v1/auth/csrf")
          return Promise.resolve(Response.json({ csrfToken: "private-csrf" }));
        expect(input).toBe(
          `/v1/me/jobs/${jobId}/reviews/${segment}/${targetId}`,
        );
        expect(init).toMatchObject({
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "x-csrf-token": "private-csrf" },
        });
        if (typeof init?.body !== "string")
          throw new Error("JSON body missing");
        expect(JSON.parse(init.body)).toEqual({
          commandId,
          expectedVersion: 0,
          ratings: ratings(dimensions),
          comment: null,
        });
        return Promise.resolve(
          Response.json(
            {
              status: "APPLIED",
              targetKind,
              targetId,
              revisionId: commandId,
              version: 1,
              recordedAt: "2026-09-20T08:20:00.000Z",
            },
            { status: 201 },
          ),
        );
      });
      await expect(
        submitJobContextReview({
          fetch: fetcher,
          jobId,
          targetKind,
          targetId,
          commandId,
          expectedVersion: 0,
          ratings: ratings(dimensions),
          comment: "",
        }),
      ).resolves.toEqual({ status: "OK", outcome: "APPLIED", version: 1 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("maps closed, locked, stale/idempotency, auth, hidden, and malformed outcomes safely", async () => {
    for (const [code, expected] of [
      ["WINDOW_CLOSED", "WINDOW_CLOSED"],
      ["EDIT_LOCKED", "EDIT_LOCKED"],
      ["STALE_VERSION", "CONFLICT"],
      ["IDEMPOTENCY_CONFLICT", "CONFLICT"],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          input === "/v1/auth/csrf"
            ? Response.json({ csrfToken: "private-csrf" })
            : Response.json({ code }, { status: 409 }),
        ),
      );
      await expect(
        submitJobContextReview({
          fetch: fetcher,
          jobId,
          targetKind: "PARTICIPANT",
          targetId: participantId,
          commandId,
          expectedVersion: 0,
          ratings: ratings(participantReviewDimensions),
          comment: "",
        }),
      ).resolves.toEqual({ status: expected });
    }
    const submit = (fetcher: typeof fetch) =>
      submitJobContextReview({
        fetch: fetcher,
        jobId,
        targetKind: "PARTICIPANT",
        targetId: participantId,
        commandId,
        expectedVersion: 0,
        ratings: ratings(participantReviewDimensions),
        comment: "",
      });
    await expect(
      submit(vi.fn(() => Promise.resolve(new Response(null, { status: 401 })))),
    ).resolves.toEqual({ status: "AUTH_REQUIRED" });
    await expect(
      submit(
        vi.fn((input) =>
          Promise.resolve(
            input === "/v1/auth/csrf"
              ? Response.json({ csrfToken: "private-csrf" })
              : Response.json({ code: "NOT_FOUND" }, { status: 404 }),
          ),
        ),
      ),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    await expect(
      submit(
        vi.fn((input) =>
          Promise.resolve(
            input === "/v1/auth/csrf"
              ? Response.json({ csrfToken: "private-csrf" })
              : Response.json({ status: "APPLIED", version: 1 }),
          ),
        ),
      ),
    ).resolves.toEqual({ status: "UNAVAILABLE" });
  });
});
