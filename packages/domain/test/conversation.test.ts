import { describe, expect, it } from "vitest";

import {
  assertConversationReadInput,
  assertInvitationConversationReadInput,
  type ConversationId,
  type JobInvitationId,
  type UserId,
} from "../src/index.js";

const actorUserId = "9e000000-0000-4000-8000-000000000001" as UserId;
const conversationId = "9e000000-0000-4000-8000-000000000002" as ConversationId;
const invitationId = "9e000000-0000-4000-8000-000000000003" as JobInvitationId;

describe("conversation read contract", () => {
  it("accepts opaque participant and conversation identities", () => {
    expect(() =>
      assertConversationReadInput({ actorUserId, conversationId }),
    ).not.toThrow();
    expect(() =>
      assertInvitationConversationReadInput({ actorUserId, invitationId }),
    ).not.toThrow();
  });

  it("rejects malformed identifiers and non-record inputs", () => {
    expect(() =>
      assertConversationReadInput({
        actorUserId,
        conversationId: "not-an-id" as ConversationId,
      }),
    ).toThrow(TypeError);
    expect(() => assertInvitationConversationReadInput(null as never)).toThrow(
      TypeError,
    );
  });
});
