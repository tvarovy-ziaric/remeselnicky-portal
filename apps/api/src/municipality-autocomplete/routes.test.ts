import type { MunicipalityAutocompletePersistence } from "@portal/db";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  MUNICIPALITY_AUTOCOMPLETE_PATH,
  registerMunicipalityAutocompleteRoutes,
} from "./routes.js";

describe("municipality autocomplete route", () => {
  it("returns only governed coarse location labels without coordinates", async () => {
    const municipalities: MunicipalityAutocompletePersistence = {
      suggest: vi.fn(() =>
        Promise.resolve([
          {
            code: "SK:BA:BRATISLAVA",
            districtName: "Bratislava I",
            name: "Bratislava",
            regionName: "Bratislavský kraj",
          },
        ]),
      ),
    };
    const app = Fastify({ logger: false });
    registerMunicipalityAutocompleteRoutes(app, {
      admission: { admit: vi.fn(() => Promise.resolve("ADMITTED" as const)) },
      municipalities,
    });
    const response = await app.inject({
      method: "GET",
      url: `${MUNICIPALITY_AUTOCOMPLETE_PATH}?q=brat`,
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      suggestions: [
        {
          code: "SK:BA:BRATISLAVA",
          districtName: "Bratislava I",
          name: "Bratislava",
          regionName: "Bratislavský kraj",
        },
      ],
    });
    expect(response.body).not.toMatch(
      /centroid|latitude|longitude|exactAddress/iu,
    );
  });

  it("rejects duplicated, unknown, and control-bearing parameters without a DB call", async () => {
    const suggest = vi.fn(() => Promise.resolve([]));
    const app = Fastify({ logger: false });
    registerMunicipalityAutocompleteRoutes(app, {
      admission: { admit: vi.fn(() => Promise.resolve("ADMITTED" as const)) },
      municipalities: { suggest },
    });
    for (const suffix of [
      "",
      "?q=a",
      "?q=obec&q=ina",
      "?q=obec&debug=1",
      "?q=obec%0Aprivate",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `${MUNICIPALITY_AUTOCOMPLETE_PATH}${suffix}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_MUNICIPALITY_QUERY" });
    }
    await app.close();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("uses shared abuse admission before reading location data", async () => {
    const suggest = vi.fn(() => Promise.resolve([]));
    const app = Fastify({ logger: false });
    registerMunicipalityAutocompleteRoutes(app, {
      admission: {
        admit: vi.fn(() => Promise.resolve("RATE_LIMITED" as const)),
      },
      municipalities: { suggest },
    });
    const response = await app.inject({
      method: "GET",
      url: `${MUNICIPALITY_AUTOCOMPLETE_PATH}?q=bratislava`,
    });
    await app.close();
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ code: "RATE_LIMITED" });
    expect(suggest).not.toHaveBeenCalled();
  });
});
