import { describe, expect, it, vi } from "vitest";

import {
  createJobMainReviewCommandId,
  customerToProviderReviewDimensions,
  type JobMainReviewRatings,
  loadJobMainReview,
  parseJobMainReviewPage,
  providerToCustomerReviewDimensions,
  reviewCanBeSubmittedOrEdited,
  submitJobMainReview,
  validJobMainReviewDraft,
} from "./job-main-review-data";

const jobId = "93600000-0000-4000-8000-000000000001";
const profileId = "93600000-0000-4000-8000-000000000002";
const revisionId = "93600000-0000-4000-8000-000000000003";
const counterpartyRevisionId = "93600000-0000-4000-8000-000000000004";
const commandId = "93600000-0000-4000-8000-000000000005";
const createCommandId = "93600000-0000-4000-8000-000000000006";
const completedAt = "2026-09-20T08:00:00.000Z";
const deadline = "2026-10-04T08:00:00.000Z";

const customerRatings = Object.fromEntries(
  customerToProviderReviewDimensions.map(([key], index) => [
    key,
    index === 0 ? 4 : null,
  ]),
) as JobMainReviewRatings;
const providerRatings = Object.fromEntries(
  providerToCustomerReviewDimensions.map(([key], index) => [
    key,
    index === 0 ? 3 : null,
  ]),
) as JobMainReviewRatings;

function page() {
  return {
    jobId,
    direction: "CUSTOMER_TO_PROVIDER",
    targetProfileId: profileId,
    targetKind: "CRAFTSMAN_PROFILE",
    acceptedProfessionCode: "PROF:ROOFING",
    completedAt,
    submissionDeadline: deadline,
    state: "OPEN",
    ownReview: null,
    counterpartyReview: null,
  };
}

function ownReview() {
  return {
    revisionId,
    version: 1,
    submittedAt: "2026-09-20T08:10:00.000Z",
    revisedAt: "2026-09-20T08:10:00.000Z",
    ratings: customerRatings,
    comment: "Vecná skúsenosť zo zákazky.",
  };
}

function counterpartyReview() {
  return {
    direction: "PROVIDER_TO_CUSTOMER",
    revisionId: counterpartyRevisionId,
    submittedAt: "2026-09-20T08:20:00.000Z",
    revisedAt: "2026-09-20T08:20:00.000Z",
    unlockedAt: "2026-09-20T08:20:00.000Z",
    ratings: providerRatings,
    comment: null,
  };
}

describe("private Job main-review client", () => {
  it("parses the exact private projection and rejects extra, malformed, or prematurely disclosed fields", () => {
    expect(parseJobMainReviewPage(page(), jobId)).toEqual(page());
    expect(
      parseJobMainReviewPage({ ...page(), authorUserId: profileId }, jobId),
    ).toBeNull();
    expect(
      parseJobMainReviewPage(
        {
          ...page(),
          ownReview: {
            ...ownReview(),
            ratings: { ...customerRatings, leak: 5 },
          },
          state: "SUBMITTED_SEALED",
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobMainReviewPage(
        { ...page(), counterpartyReview: counterpartyReview() },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobMainReviewPage(
        {
          ...page(),
          state: "SUBMITTED_SEALED",
          ownReview: ownReview(),
          counterpartyReview: counterpartyReview(),
        },
        jobId,
      ),
    ).toBeNull();
    expect(
      parseJobMainReviewPage(
        {
          ...page(),
          state: "UNLOCKED",
          ownReview: ownReview(),
          counterpartyReview: counterpartyReview(),
        },
        jobId,
      ),
    ).not.toBeNull();
    expect(
      parseJobMainReviewPage(
        {
          ...page(),
          state: "EXPIRED_UNSUBMITTED",
          counterpartyReview: counterpartyReview(),
        },
        jobId,
      ),
    ).not.toBeNull();
  });

  it("rejects all-N/A and wrong-direction drafts and closes submit/edit locally after unlock, expiry, or 60 minutes", () => {
    const allNull = Object.fromEntries(
      customerToProviderReviewDimensions.map(([key]) => [key, null]),
    ) as JobMainReviewRatings;
    expect(validJobMainReviewDraft("CUSTOMER_TO_PROVIDER", allNull, "")).toBe(
      false,
    );
    expect(
      validJobMainReviewDraft("CUSTOMER_TO_PROVIDER", providerRatings, ""),
    ).toBe(false);
    expect(
      validJobMainReviewDraft(
        "CUSTOMER_TO_PROVIDER",
        Object.fromEntries(
          customerToProviderReviewDimensions.map(([key]) => [
            key,
            key === "would_hire_again" ? 5 : null,
          ]),
        ) as JobMainReviewRatings,
        "",
      ),
    ).toBe(true);
    expect(
      parseJobMainReviewPage(
        {
          ...page(),
          state: "SUBMITTED_SEALED",
          ownReview: {
            ...ownReview(),
            ratings: Object.fromEntries(
              customerToProviderReviewDimensions.map(([key]) => [
                key,
                key === "would_hire_again" ? 5 : null,
              ]),
            ),
          },
        },
        jobId,
      ),
    ).not.toBeNull();
    expect(
      validJobMainReviewDraft(
        "CUSTOMER_TO_PROVIDER",
        customerRatings,
        "Vecná skúsenosť.",
      ),
    ).toBe(true);
    const open = parseJobMainReviewPage(page(), jobId);
    expect(open).not.toBeNull();
    if (!open) return;
    expect(reviewCanBeSubmittedOrEdited(open, Date.parse(completedAt))).toBe(
      true,
    );
    expect(reviewCanBeSubmittedOrEdited(open, Date.parse(deadline))).toBe(
      false,
    );
    const sealed = parseJobMainReviewPage(
      { ...page(), state: "SUBMITTED_SEALED", ownReview: ownReview() },
      jobId,
    );
    expect(sealed).not.toBeNull();
    if (!sealed) return;
    expect(
      reviewCanBeSubmittedOrEdited(
        sealed,
        Date.parse(ownReview().submittedAt) + 59 * 60 * 1_000,
      ),
    ).toBe(true);
    expect(
      reviewCanBeSubmittedOrEdited(
        sealed,
        Date.parse(ownReview().submittedAt) + 60 * 60 * 1_000,
      ),
    ).toBe(false);
    const unlocked = parseJobMainReviewPage(
      { ...page(), state: "UNLOCKED", ownReview: ownReview() },
      jobId,
    );
    expect(unlocked).not.toBeNull();
    if (unlocked)
      expect(
        reviewCanBeSubmittedOrEdited(unlocked, Date.parse(completedAt)),
      ).toBe(false);
  });

  it("loads only the exact same-origin private path and fails closed", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(page())),
    );
    expect(await loadJobMainReview({ fetch: fetcher, jobId })).toMatchObject({
      status: "OK",
      page: page(),
    });
    expect(fetcher).toHaveBeenCalledWith(`/v1/me/jobs/${jobId}/reviews/main`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    const leaking = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ ...page(), hiddenReview: {} })),
    );
    expect((await loadJobMainReview({ fetch: leaking, jobId })).status).toBe(
      "UNAVAILABLE",
    );
  });

  it("uses a cryptographic UUID and sends exact create/edit versions with CSRF", async () => {
    expect(createJobMainReviewCommandId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    const postBodies: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      if (input === "/v1/auth/csrf")
        return Promise.resolve(Response.json({ csrfToken: "private-csrf" }));
      expect(input).toBe(`/v1/me/jobs/${jobId}/reviews/main`);
      expect(init?.headers).toMatchObject({ "x-csrf-token": "private-csrf" });
      if (typeof init?.body !== "string")
        throw new Error("JSON command body missing");
      const body = JSON.parse(init.body) as {
        commandId: string;
        expectedVersion: number;
      };
      postBodies.push(body);
      return Promise.resolve(
        Response.json(
          {
            status: "APPLIED",
            direction: "CUSTOMER_TO_PROVIDER",
            revisionId: body.commandId,
            version: body.expectedVersion + 1,
            recordedAt: "2026-09-20T08:30:00.000Z",
          },
          { status: 201 },
        ),
      );
    });
    expect(
      await submitJobMainReview({
        fetch: fetcher,
        jobId,
        commandId: createCommandId,
        expectedVersion: 0,
        direction: "CUSTOMER_TO_PROVIDER",
        ratings: customerRatings,
        comment: "",
      }),
    ).toEqual({ status: "OK", outcome: "APPLIED", version: 1 });
    expect(
      await submitJobMainReview({
        fetch: fetcher,
        jobId,
        commandId,
        expectedVersion: 1,
        direction: "CUSTOMER_TO_PROVIDER",
        ratings: customerRatings,
        comment: "Upravená vecná skúsenosť.",
      }),
    ).toEqual({ status: "OK", outcome: "APPLIED", version: 2 });
    expect(postBodies).toEqual([
      {
        commandId: createCommandId,
        expectedVersion: 0,
        ratings: customerRatings,
        comment: null,
      },
      {
        commandId,
        expectedVersion: 1,
        ratings: customerRatings,
        comment: "Upravená vecná skúsenosť.",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("maps server edit/window conflicts without weakening the fail-closed response parser", async () => {
    for (const [code, expected] of [
      ["WINDOW_CLOSED", "WINDOW_CLOSED"],
      ["EDIT_LOCKED", "EDIT_LOCKED"],
      ["STALE_VERSION", "CONFLICT"],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          input === "/v1/auth/csrf"
            ? Response.json({ csrfToken: "private-csrf" })
            : Response.json({ code }, { status: 409 }),
        ),
      );
      expect(
        await submitJobMainReview({
          fetch: fetcher,
          jobId,
          commandId,
          expectedVersion: 0,
          direction: "CUSTOMER_TO_PROVIDER",
          ratings: customerRatings,
          comment: "",
        }),
      ).toEqual({ status: expected });
    }
  });
});
