import { describe, expect, it } from "vitest";

import { runWorker } from "./worker.js";

describe("worker skeleton", () => {
  it("loads the shared contract and domain package boundaries", () => {
    expect(runWorker()).toEqual({
      apiVersion: "v1",
      service: "worker",
      sharedDomainLoaded: true,
      status: "ready",
    });
  });
});
