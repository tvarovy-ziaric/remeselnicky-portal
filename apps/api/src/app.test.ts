import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "./app.js";

const openApps: ReturnType<typeof buildApi>[] = [];

function createAvailableDatabase() {
  return {
    ping(): Promise<void> {
      return Promise.resolve();
    },
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("API skeleton", () => {
  it("returns its service status and shared API version", async () => {
    const app = buildApi({ database: createAvailableDatabase() });
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
    const app = buildApi({ database: createAvailableDatabase() });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/resources" });

    expect(response.statusCode).toBe(404);
  });

  it("reports liveness independently of database availability", async () => {
    const app = buildApi({
      database: {
        ping(): Promise<void> {
          return Promise.reject(
            new Error("connection contains a secret and must not leak"),
          );
        },
      },
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports readiness when the database responds", async () => {
    const app = buildApi({ database: createAvailableDatabase() });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checks: { database: "available" },
      status: "ready",
    });
  });

  it("reports only a safe unavailable state when the database rejects", async () => {
    const app = buildApi({
      database: {
        ping(): Promise<void> {
          return Promise.reject(
            new Error("postgresql://user:secret@database.invalid/portal"),
          );
        },
      },
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      checks: { database: "unavailable" },
      status: "not_ready",
    });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("database.invalid");
  });
});
