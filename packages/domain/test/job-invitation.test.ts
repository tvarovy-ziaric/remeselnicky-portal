import { describe, expect, it } from "vitest";

import {
  assertRespondToJobInvitationInput,
  transitionJobInvitation,
  type JobInvitationId,
} from "../src/job-invitation.js";
import type { UserId } from "../src/user.js";

const base = {
  actorUserId: "9c000000-0000-4000-8000-000000000001" as UserId,
  commandId: "9c000000-0000-4000-8000-000000000002",
  expectedRevision: 1,
  invitationId: "9c000000-0000-4000-8000-000000000003" as JobInvitationId,
} as const;

describe("job invitation", () => {
  it("keeps the compact invitation state machine explicit", () => {
    expect(transitionJobInvitation(null, "SEND")).toBe("PENDING");
    expect(transitionJobInvitation("PENDING", "ENGAGE")).toBe("ENGAGED");
    expect(transitionJobInvitation("PENDING", "DECLINE")).toBe("DECLINED");
    expect(transitionJobInvitation("PENDING", "EXPIRE")).toBe("EXPIRED");
    expect(transitionJobInvitation("ENGAGED", "CUSTOMER_STOP")).toBe(
      "NOT_SELECTED",
    );
    expect(transitionJobInvitation("ENGAGED", "CRAFTSMAN_WITHDRAW")).toBe(
      "WITHDRAWN",
    );
    expect(transitionJobInvitation("DECLINED", "ENGAGE")).toBeNull();
  });

  it("keeps decline context bounded and out of engagement", () => {
    expect(() =>
      assertRespondToJobInvitationInput({
        ...base,
        action: "DECLINE",
        declineNote: "Termín mi nevyhovuje",
        declineReason: "TIMING",
      }),
    ).not.toThrow();
    expect(() =>
      assertRespondToJobInvitationInput({
        ...base,
        action: "ENGAGE",
        declineReason: "OTHER",
      }),
    ).toThrow(TypeError);
    expect(() =>
      assertRespondToJobInvitationInput({
        ...base,
        action: "DECLINE",
        declineNote: "x".repeat(501),
      }),
    ).toThrow(TypeError);
    for (const declineNote of [
      "Napíšte mi na majster@example.sk",
      "Volajte +421 900 123 456",
      "Viac na https://example.sk",
    ]) {
      expect(() =>
        assertRespondToJobInvitationInput({
          ...base,
          action: "DECLINE",
          declineNote,
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      assertRespondToJobInvitationInput({ ...base, action: "DECLINE" }),
    ).not.toThrow();
  });
});
