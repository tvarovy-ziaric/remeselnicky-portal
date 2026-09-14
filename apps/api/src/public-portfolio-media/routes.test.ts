import type { PublicPortfolioDeliveryResolver } from "@portal/media";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "../app.js";

const mediaAssetId = "85000000-0000-4000-8000-000000000001";
const publicLocation = "https://media.example.test/public/photo.webp";
const openApps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("public portfolio media route", () => {
  it("redirects an exact eligible public derivative without caching", async () => {
    const resolve = vi.fn(() =>
      Promise.resolve({
        headers: {
          "cache-control": "private, no-store",
          location: publicLocation,
          "x-content-type-options": "nosniff",
        },
        statusCode: 302 as const,
      }),
    );
    const response = await apiWith({ resolve }).inject({
      method: "GET",
      url: `/v1/public/media/${mediaAssetId}`,
    });

    expect(resolve).toHaveBeenCalledWith(mediaAssetId);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(publicLocation);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toBe("");
  });

  it.each(["hidden", "revoked", "unknown", "malformed"])(
    "returns the same no-store 404 for %s media",
    async () => {
      const response = await apiWith({
        resolve: () =>
          Promise.resolve({
            body: { code: "MEDIA_NOT_FOUND" },
            headers: { "cache-control": "private, no-store" },
            statusCode: 404,
          }),
      }).inject({
        method: "GET",
        url: `/v1/public/media/${mediaAssetId}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "MEDIA_NOT_FOUND" });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers.location).toBeUndefined();
    },
  );

  it("does not disclose delivery failures", async () => {
    const response = await apiWith({
      resolve: () =>
        Promise.reject(
          new Error("private/storage/key postgresql://secret@database"),
        ),
    }).inject({
      method: "GET",
      url: `/v1/public/media/${mediaAssetId}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "MEDIA_NOT_FOUND" });
    expect(response.body).not.toMatch(/private|storage|postgres|secret/iu);
  });
});

function apiWith(delivery: PublicPortfolioDeliveryResolver) {
  const app = buildApi({
    database: { ping: () => Promise.resolve() },
    publicPortfolioMedia: { delivery },
  });
  openApps.push(app);
  return app;
}
