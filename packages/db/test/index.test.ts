import { describe, expect, it, vi } from "vitest";

import { createDatabaseHealthProbe } from "../src/index.js";

describe("database health probe", () => {
  it("executes the injected parameterized health query", async () => {
    const execute = vi.fn(() => Promise.resolve([{ health: 1 }]));
    const probe = createDatabaseHealthProbe(execute);

    await expect(probe.ping()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves unavailability as a rejected probe without formatting secrets", async () => {
    const unavailable = new Error("connection refused");
    const probe = createDatabaseHealthProbe(() => Promise.reject(unavailable));

    await expect(probe.ping()).rejects.toBe(unavailable);
  });
});
