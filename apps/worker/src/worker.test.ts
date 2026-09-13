import { describe, expect, it } from "vitest";

import { runWorker } from "./worker.js";
import { runWorkerLoop } from "./service.js";

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

  it("runs as an independently stoppable polling process", async () => {
    const abortController = new AbortController();
    let polls = 0;

    await runWorkerLoop({
      processor: {
        processNext: () => {
          polls += 1;
          abortController.abort();
          return Promise.resolve({ status: "idle" });
        },
      },
      signal: abortController.signal,
      sleep: () => Promise.reject(new Error("must not sleep after abort")),
    });

    expect(polls).toBe(1);
  });
});
