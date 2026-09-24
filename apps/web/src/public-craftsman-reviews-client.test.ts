import { describe, expect, it, vi } from "vitest";

import {
  createPublicCraftsmanReviewsLoader,
  isPublicCraftsmanReviewsCursor,
  parsePublicCraftsmanReviewsPage,
} from "./public-craftsman-reviews-client";

const profileId = "84000000-0000-4000-8000-000000000001";
const reviewId = "84000000-0000-4000-8000-000000000002";
const nextId = "84000000-0000-4000-8000-000000000003";

describe("public craftsman reviews parser", () => {
  it("copies only the exact privacy-minimized public fields", () => {
    const result = parsePublicCraftsmanReviewsPage(page());

    expect(result).toEqual(page());
    expect(JSON.stringify(result)).not.toMatch(
      /jobId|customerId|customerName|submittedAt|exactAddress|email/iu,
    );
  });

  it("fails closed for extra identity, Job, or timestamp fields", () => {
    for (const extra of [
      { customerName: "Anna" },
      { jobId: "84000000-0000-4000-8000-000000000099" },
      { submittedAt: "2026-09-01T12:30:00.000Z" },
    ]) {
      expect(
        parsePublicCraftsmanReviewsPage({
          ...page(),
          reviews: [{ ...review(), ...extra }],
        }),
      ).toBeNull();
    }
  });

  it("rejects comments containing public contact, address, or secret data", () => {
    for (const comment of [
      "Kontaktujte ma na anna@example.test",
      "Volajte +421 900 123 456",
      "Realizácia bola na adrese Tajná 12",
      "Môj access token je tajný.",
    ]) {
      expect(
        parsePublicCraftsmanReviewsPage({
          ...page(),
          reviews: [{ ...review(), comment }],
        }),
      ).toBeNull();
    }
  });

  it("rejects malformed or privacy-unsafe public response projections", () => {
    for (const response of [
      { ...review().response, extra: true },
      { ...review().response, responseId: "private" },
      { ...review().response, body: "Kontakt +421 900 123 456" },
      { ...review().response, respondedMonth: "2026-09-24" },
    ]) {
      expect(
        parsePublicCraftsmanReviewsPage({
          ...page(),
          reviews: [{ ...review(), response }],
        }),
      ).toBeNull();
    }
  });

  it("rejects malformed ratings, score, month, duplicates, and cursors", () => {
    const invalidReviews = [
      { ...review(), ratings: { ...review().ratings, extra: 5 } },
      {
        ...review(),
        ratings: Object.fromEntries(
          Object.keys(review().ratings).map((key) => [key, null]),
        ),
      },
      { ...review(), ratings: { ...review().ratings, work_quality: 6 } },
      { ...review(), score: Number.NaN },
      { ...review(), score: 0.9 },
      { ...review(), score: 1 },
      { ...review(), reviewedMonth: "2026-13" },
      { ...review(), professionCode: "../../private" },
    ];
    for (const candidate of invalidReviews) {
      expect(
        parsePublicCraftsmanReviewsPage({
          reviews: [candidate],
          nextCursor: null,
        }),
      ).toBeNull();
    }
    expect(
      parsePublicCraftsmanReviewsPage({
        reviews: [review(), review()],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      parsePublicCraftsmanReviewsPage({
        reviews: [],
        nextCursor: `v1.${nextId}`,
      }),
    ).toBeNull();
    expect(
      parsePublicCraftsmanReviewsPage({
        reviews: [review()],
        nextCursor: "../../private",
      }),
    ).toBeNull();
  });

  it("accepts only the versioned opaque cursor shape", () => {
    expect(isPublicCraftsmanReviewsCursor(`v1.${nextId}`)).toBe(true);
    expect(isPublicCraftsmanReviewsCursor(nextId)).toBe(false);
    expect(isPublicCraftsmanReviewsCursor([`v1.${nextId}`])).toBe(false);
  });
});

describe("public craftsman reviews loader", () => {
  it("requests at most ten reviews through the no-store public endpoint", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(page()), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    const load = createPublicCraftsmanReviewsLoader({
      apiOrigin: "http://api:3001",
      fetch: fetcher,
    });

    await expect(load(profileId, `v1.${nextId}`)).resolves.toEqual(page());
    expect(fetcher).toHaveBeenCalledWith(
      new URL(
        `http://api:3001/v1/public/craftsmen/${profileId}/reviews?limit=10&cursor=v1.${nextId}`,
      ),
      { cache: "no-store", headers: { accept: "application/json" } },
    );
  });

  it("maps non-success and malformed payloads to the same safe absence", async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 503 }),
      new Response(JSON.stringify({ ...page(), internal: true }), {
        status: 200,
      }),
    ]) {
      const load = createPublicCraftsmanReviewsLoader({
        apiOrigin: "http://api:3001",
        fetch: () => Promise.resolve(response),
      });
      await expect(load(profileId)).resolves.toBeNull();
    }
  });

  it("does not fetch for an unsafe origin, profile ID, or cursor", async () => {
    const fetcher = vi.fn();
    for (const [origin, id, candidateCursor] of [
      ["https://user:secret@example.test/private", profileId, undefined],
      ["http://api:3001", "../private", undefined],
      ["http://api:3001", profileId, "../../private"],
    ] as const) {
      const load = createPublicCraftsmanReviewsLoader({
        apiOrigin: origin,
        fetch: fetcher,
      });
      await expect(load(id, candidateCursor)).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function page() {
  return { reviews: [review()], nextCursor: `v1.${nextId}` };
}

function review() {
  return {
    reviewId,
    professionCode: "PROF:CARPENTER",
    ratings: {
      work_quality: 5,
      price_adherence: 4,
      schedule_adherence: null,
      communication: 5,
      cleanliness: 4,
      problem_solving: 5,
      would_hire_again: 5,
    },
    score: 4.67,
    comment: "Poctivá práca a dobrá komunikácia.",
    reviewedMonth: "2026-09",
    response: {
      responseId: nextId,
      body: "Ďakujem za spätnú väzbu.",
      respondedMonth: "2026-09",
    },
  };
}
