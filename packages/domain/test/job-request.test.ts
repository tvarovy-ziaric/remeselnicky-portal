import { describe, expect, it, vi } from "vitest";

import type { CustomerProfileId } from "../src/customer-profile.js";
import {
  assertActivateJobRequestInput,
  createJobRequestService,
  transitionJobRequest,
  type JobRequestId,
} from "../src/job-request.js";
import type { UserId } from "../src/user.js";

const actor = "95000000-0000-4000-8000-000000000001" as UserId;
const customer = "95000000-0000-4000-8000-000000000002" as CustomerProfileId;
const request = "95000000-0000-4000-8000-000000000003" as JobRequestId;
const commandId = "95000000-0000-4000-8000-000000000004";

describe("JobRequest", () => {
  it("allows only explicit request lifecycle transitions", () => {
    expect(transitionJobRequest("DRAFT", "ACTIVATE")).toBe("ACTIVE");
    expect(transitionJobRequest("ACTIVE", "ACTIVATE")).toBeNull();
    expect(transitionJobRequest("ACTIVE", "EXTEND")).toBe("ACTIVE");
    expect(transitionJobRequest("ACTIVE", "EXPIRE")).toBe("EXPIRED");
    expect(transitionJobRequest("EXPIRED", "REACTIVATE")).toBe("ACTIVE");
    expect(transitionJobRequest("ACTIVE", "CANCEL")).toBe("CANCELLED");
    expect(transitionJobRequest("CANCELLED", "REACTIVATE")).toBeNull();
  });

  it("derives the private customer owner during first draft creation", async () => {
    const ensureForCustomerUse = vi.fn().mockResolvedValue({
      profile: { id: customer },
      status: "CREATED",
    });
    const createDraftOwned = vi.fn().mockResolvedValue({ status: "APPLIED" });
    const service = createJobRequestService({
      customerProfiles: { ensureForCustomerUse },
      persistence: {
        activateOwned: vi.fn(),
        createDraftOwned,
      },
    });

    await service.createDraft({ actorUserId: actor, commandId });

    expect(ensureForCustomerUse).toHaveBeenCalledWith(actor);
    expect(createDraftOwned).toHaveBeenCalledWith({
      actorUserId: actor,
      commandId,
      customerProfileId: customer,
    });
  });

  it("rejects invalid identifiers and revisions before persistence", () => {
    expect(() =>
      assertActivateJobRequestInput({
        actorUserId: actor,
        commandId,
        expectedRevision: 0,
        jobRequestId: request,
      }),
    ).toThrow(/expectedRevision/u);
  });
});
