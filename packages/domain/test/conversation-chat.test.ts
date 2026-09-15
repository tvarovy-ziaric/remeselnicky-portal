import { describe, expect, it, vi } from "vitest";

import {
  ConversationChatIdempotencyError,
  assertConversationParticipantStateInput,
  assertConversationReportInput,
  assertConversationTimelineReadInput,
  createConversationChatService,
  createPreConfirmationConversationMessageAdmission,
  normalizeConversationMessageSendInput,
  type ConversationChatPersistence,
  type ConversationId,
  type UserId,
} from "../src/index.js";

const actorUserId = "95000000-0000-4000-8000-000000000001" as UserId;
const conversationId = "95000000-0000-4000-8000-000000000002" as ConversationId;
const commandId = "95000000-0000-4000-8000-000000000003";

describe("conversation chat domain", () => {
  it("normalizes basic line breaks while preserving plain text and emoji", () => {
    expect(
      normalizeConversationMessageSendInput({
        actorUserId,
        body: "  Dobrý deň\r\nMôžeme začať? 🛠️  ",
        commandId,
        conversationId,
      }).body,
    ).toBe("Dobrý deň\nMôžeme začať? 🛠️");
  });

  it.each(["", "x".repeat(4_001), "ahoj\u0000svet"])(
    "rejects malformed message text %#",
    (body) => {
      expect(() =>
        normalizeConversationMessageSendInput({
          actorUserId,
          body,
          commandId,
          conversationId,
        }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    "Napíš na meno@example.sk",
    "Volaj +421 900 123 456",
    "PSČ je 811 01",
    "Adresa: Hlavná 12",
  ])(
    "blocks obvious pre-confirmation contact or address text",
    async (body) => {
      await expect(
        createPreConfirmationConversationMessageAdmission().evaluate({ body }),
      ).resolves.toBe("BLOCK");
    },
  );

  it("allows ordinary text and general link handling to remain a UI concern", async () => {
    await expect(
      createPreConfirmationConversationMessageAdmission().evaluate({
        body: "Pozrite si technický list https://example.org/material.pdf",
      }),
    ).resolves.toBe("ALLOW");
  });

  it("does not call persistence when admission blocks the message", async () => {
    const sendMessage = vi.fn();
    const persistence: ConversationChatPersistence = {
      readTimeline: vi.fn(),
      report: vi.fn(),
      sendMessage,
      updateParticipantState: vi.fn(),
    };
    const service = createConversationChatService({
      admission: { evaluate: () => Promise.resolve("BLOCK") },
      persistence,
    });
    await expect(
      service.sendMessage({
        actorUserId,
        body: "kontakt",
        commandId,
        conversationId,
      }),
    ).resolves.toEqual({ status: "BLOCKED_BY_CONTACT_POLICY" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("validates read, state and privacy-minimal report inputs", () => {
    expect(() =>
      assertConversationTimelineReadInput({
        actorUserId,
        beforeSequence: 10,
        conversationId,
        limit: 50,
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationParticipantStateInput({
        action: "MARK_READ",
        actorUserId,
        commandId,
        conversationId,
        expectedRevision: 0,
        readThroughSequence: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertConversationParticipantStateInput({
        action: "MUTE",
        actorUserId,
        commandId,
        conversationId,
        expectedRevision: 0,
        readThroughSequence: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      assertConversationReportInput({
        actorUserId,
        commandId,
        conversationId,
        reason: "ABUSE",
      }),
    ).not.toThrow();
  });

  it("exports a stable idempotency conflict code", () => {
    expect(new ConversationChatIdempotencyError().code).toBe(
      "CONVERSATION_CHAT_IDEMPOTENCY_CONFLICT",
    );
  });
});
