import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "./app.js";

const openApps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("API skeleton", () => {
  it("returns its service status and shared API version", async () => {
    const app = buildApi();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiVersion: "v1",
      service: "api",
      status: "ok",
    });
  });

  it("does not expose an undeclared generic API route", async () => {
    const app = buildApi();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/resources" });

    expect(response.statusCode).toBe(404);
  });
});
