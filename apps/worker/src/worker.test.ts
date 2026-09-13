import { describe, expect, it } from "vitest";

import { runWorker } from "./worker.js";

describe("worker skeleton", () => {
  it("loads the shared contract and domain package boundaries", () => {
    expect(
      runWorker({ environment: "staging", releaseRevision: "test-revision" }),
    ).toEqual({
      apiVersion: "v1",
      environment: "staging",
      releaseRevision: "test-revision",
      service: "worker",
      sharedDomainLoaded: true,
      status: "ready",
    });
  });
});
