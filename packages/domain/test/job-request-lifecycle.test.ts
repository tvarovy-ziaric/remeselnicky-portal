import { describe, expect, it } from "vitest";

import {
  assertCancelJobRequestInput,
  assertDuplicateJobRequestInput,
  assertJobRequestLifecycleCommandInput,
  JOB_REQUEST_DEFAULT_ACTIVE_LIMIT,
  JOB_REQUEST_DEFAULT_INACTIVITY_DAYS,
  type JobRequestId,
  type UserId,
} from "../src/index.js";

const actor = "99100000-0000-4000-8000-000000000001" as UserId;
const request = "99100000-0000-4000-8000-000000000002" as JobRequestId;
const commandId = "99100000-0000-4000-8000-000000000003";

describe("job request lifecycle commands", () => {
  it("keeps the alpha policy defaults explicit and reversible", () => {
    expect(JOB_REQUEST_DEFAULT_ACTIVE_LIMIT).toBe(5);
    expect(JOB_REQUEST_DEFAULT_INACTIVITY_DAYS).toBe(30);
  });

  it("validates extend/reactivate command revisions", () => {
    expect(() =>
      assertJobRequestLifecycleCommandInput({
        actorUserId: actor,
        commandId,
        expectedRevision: 1,
        jobRequestId: request,
      }),
    ).not.toThrow();
    expect(() =>
      assertJobRequestLifecycleCommandInput({
        actorUserId: actor,
        commandId,
        expectedRevision: 0,
        jobRequestId: request,
      }),
    ).toThrow(/revision/u);
  });

  it("allowlists cancellation reasons and duplicate provenance", () => {
    expect(() =>
      assertCancelJobRequestInput({
        actorUserId: actor,
        commandId,
        expectedRevision: 2,
        jobRequestId: request,
        reason: "PLANS_CHANGED",
      }),
    ).not.toThrow();
    expect(() =>
      assertDuplicateJobRequestInput({
        actorUserId: actor,
        commandId,
        sourceJobRequestId: request,
      }),
    ).not.toThrow();
  });
});
