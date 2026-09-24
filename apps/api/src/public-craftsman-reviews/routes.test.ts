import { PublicCraftsmanReviewQueryValidationError } from "@portal/db";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_CRAFTSMAN_REVIEWS_PATH,
  registerPublicCraftsmanReviewRoutes,
  type PublicCraftsmanReviewRouteDependencies,
} from "./routes.js";
import { buildApi } from "../app.js";

const profileId = "a1000000-0000-4000-8000-000000000001";
const reviewId = "a1000000-0000-4000-8000-000000000002";
const cursor = "v1.a1000000-0000-4000-8000-000000000003";
const reviewsPath = PUBLIC_CRAFTSMAN_REVIEWS_PATH.replace(
  ":profileId",
  profileId,
);
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("public craftsman review route", () => {
  it("returns only the public allowlist with no-store and no indexing", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            ...review(),
            customerId: "private-customer",
            jobId: "private-job",
            reviewerName: "Private Customer",
            submittedAt: "2026-09-20T10:15:00.000Z",
          },
        ],
        nextCursor: cursor,
      }),
    );
    const app = apiWith({ list });

    const response = await app.inject({
      method: "GET",
      url: `${reviewsPath}?limit=10`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      reviews: [review()],
      nextCursor: cursor,
    });
    expect(response.body).not.toMatch(
      /customerId|reviewerName|jobId|submittedAt|private-customer|private-job/iu,
    );
    expect(list).toHaveBeenCalledWith({
      craftsmanProfileId: profileId,
      limit: 10,
    });
  });

  it("passes a bounded limit and opaque cursor without decoding its contents", async () => {
    const list = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const app = apiWith({ list });

    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}/reviews?limit=20&cursor=${cursor}`,
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({
      craftsmanProfileId: profileId,
      cursor,
      limit: 20,
    });
  });

  it.each(["unknown", "non-public", "suspended", "moderated"])(
    "uses the same 404 for a %s profile",
    async () => {
      const app = apiWith({ list: () => Promise.resolve(null) });
      const response = await app.inject({
        method: "GET",
        url: `/v1/public/craftsmen/${profileId}/reviews`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "NOT_FOUND" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    },
  );

  it.each([
    "?limit=0",
    "?limit=21",
    "?limit=1.5",
    "?limit=01",
    "?limit=10&limit=11",
    "?cursor=",
    "?cursor=%20v1.token",
    "?cursor=a&cursor=b",
    "?unknown=value",
  ])(
    "rejects the invalid query %s before admission or persistence",
    async (query) => {
      const admit = vi.fn(() => Promise.resolve("ADMITTED" as const));
      const list = vi.fn(() =>
        Promise.resolve({ items: [], nextCursor: null }),
      );
      const app = apiWith({ list }, { admit });

      const response = await app.inject({
        method: "GET",
        url: `/v1/public/craftsmen/${profileId}/reviews${query}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(admit).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed profile identifier before admission", async () => {
    const admit = vi.fn(() => Promise.resolve("ADMITTED" as const));
    const list = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const app = apiWith({ list }, { admit });

    const response = await app.inject({
      method: "GET",
      url: "/v1/public/craftsmen/not-a-uuid/reviews",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(admit).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("rate limits before reading any review data", async () => {
    const list = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const app = apiWith(
      { list },
      {
        admit: () => Promise.resolve("RATE_LIMITED"),
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}/reviews`,
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ code: "RATE_LIMITED" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed when admission is unavailable", async () => {
    const list = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
    const app = apiWith(
      { list },
      {
        admit: () => Promise.reject(new Error("raw IP 198.51.100.9")),
      },
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}/reviews`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toContain("198.51.100.9");
    expect(list).not.toHaveBeenCalled();
  });

  it("redacts persistence failures", async () => {
    const app = apiWith({
      list: () =>
        Promise.reject(
          new Error("postgresql://owner:secret@db/private_customer"),
        ),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}/reviews`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toMatch(/postgres|secret|private_customer/iu);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("maps a malformed or profile-mismatched opaque cursor to a bounded 400", async () => {
    const app = apiWith({
      list: () =>
        Promise.reject(
          new PublicCraftsmanReviewQueryValidationError(
            "private cursor anchor detail",
          ),
        ),
    });

    const response = await app.inject({
      method: "GET",
      url: `${reviewsPath}?cursor=${cursor}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(response.body).not.toContain("private cursor anchor detail");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("fails closed when the admission dependency is missing", async () => {
    const app = Fastify();
    apps.push(app);
    registerPublicCraftsmanReviewRoutes(app, {
      reviews: { list: () => Promise.resolve({ items: [], nextCursor: null }) },
    } as unknown as PublicCraftsmanReviewRouteDependencies);

    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}/reviews`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
  });
});

function apiWith(
  reviews: PublicCraftsmanReviewRouteDependencies["reviews"],
  admission: PublicCraftsmanReviewRouteDependencies["admission"] = {
    admit: () => Promise.resolve("ADMITTED"),
  },
) {
  const app = buildApi({
    database: { ping: () => Promise.resolve() },
    publicCraftsmanReviews: { admission, reviews },
  });
  apps.push(app);
  return app;
}

function review() {
  return {
    reviewId,
    professionCode: "PROF:TILER",
    ratings: {
      work_quality: 5 as const,
      price_adherence: 4 as const,
      schedule_adherence: null,
      communication: 5 as const,
      cleanliness: 4 as const,
      problem_solving: 5 as const,
      would_hire_again: 5 as const,
    },
    score: 4.67,
    comment: "Precízna práca.",
    reviewedMonth: "2026-09",
  };
}
