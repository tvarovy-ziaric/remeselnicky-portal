import { describe, expect, it } from "vitest";

import { parsePublicSearchContext } from "./public-search-context";

const jobId = "99000000-0000-4000-8000-000000000020";
const requestId = "99000000-0000-4000-8000-000000000010";

describe("public search context", () => {
  it("preserves only an opaque Job ID for provider invitation UX and never forwards it to public search", () => {
    expect(
      parsePublicSearchContext({
        jobId,
        professionCode: "PROF:TILER",
        skillCodes: ["SKILL:CUT"],
        customerEmail: "private@example.test",
        exactAddress: "Private 42",
      }),
    ).toEqual({
      jobId,
      searchParameters: {
        professionCode: "PROF:TILER",
        skillCodes: ["SKILL:CUT"],
      },
    });
  });

  it("fails closed on ambiguous, malformed, and repeated context", () => {
    for (const parameters of [
      { jobId, jobRequestId: requestId },
      { jobId: "bad" },
      { jobId: [jobId, jobId] },
    ]) {
      const context = parsePublicSearchContext(parameters);
      expect(context.jobId).toBeUndefined();
      expect(context.jobRequestId).toBeUndefined();
    }
    expect(parsePublicSearchContext({ jobRequestId: requestId })).toEqual({
      jobRequestId: requestId,
      searchParameters: {},
    });
  });
});
