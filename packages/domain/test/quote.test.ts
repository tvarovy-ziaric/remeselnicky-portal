import { describe, expect, it, vi } from "vitest";

import {
  QuoteIdempotencyError,
  assertCreateQuoteDraftInput,
  assertRejectQuoteRevisionInput,
  createQuoteService,
  normalizeRejectQuoteRevisionInput,
  transitionQuoteRevision,
  type QuoteId,
  type QuotePersistence,
} from "../src/quote.js";
import type { ConversationId } from "../src/conversation.js";
import type { UserId } from "../src/user.js";

const actorUserId = "98000000-0000-4000-8000-000000000001" as UserId;
const conversationId = "98000000-0000-4000-8000-000000000002" as ConversationId;
const quoteId = "98000000-0000-4000-8000-000000000003" as QuoteId;
const commandId = "98000000-0000-4000-8000-000000000004" as const;

describe("quote core", () => {
  it("locks the lifecycle vocabulary while exposing only bounded core transitions", () => {
    expect(transitionQuoteRevision("DRAFT", "SUBMIT")).toBe("SUBMITTED");
    expect(transitionQuoteRevision("SUBMITTED", "SUPERSEDE")).toBe(
      "SUPERSEDED",
    );
    expect(transitionQuoteRevision("SUBMITTED", "REJECT")).toBe("REJECTED");
    expect(transitionQuoteRevision("SUBMITTED", "WITHDRAW")).toBe("WITHDRAWN");
    expect(transitionQuoteRevision("SUBMITTED", "EXPIRE")).toBe("EXPIRED");
    expect(transitionQuoteRevision("SUBMITTED", "ACCEPT")).toBe("ACCEPTED");
    expect(transitionQuoteRevision("SUBMITTED", "NOT_SELECT")).toBe(
      "NOT_SELECTED",
    );
    expect(transitionQuoteRevision("REJECTED", "SUBMIT")).toBeNull();
    expect(transitionQuoteRevision("DRAFT", "REJECT")).toBeNull();
  });

  it("validates IDs, exact request provenance and authoring mode", () => {
    expect(() =>
      assertCreateQuoteDraftInput({
        actorUserId,
        authoringMode: "PLATFORM_STRUCTURED",
        commandId,
        conversationId,
        requestContentRevision: 2,
        requestVisibleVersion: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertCreateQuoteDraftInput({
        actorUserId,
        authoringMode: "EXTERNAL_PDF",
        commandId,
        conversationId,
        requestContentRevision: 0,
        requestVisibleVersion: 1,
      }),
    ).toThrow(TypeError);
  });

  it("normalizes an optional rejection reason without accepting control text", () => {
    expect(
      normalizeRejectQuoteRevisionInput({
        actorUserId,
        commandId,
        expectedStateRevision: 1,
        quoteId,
        rejectionReason: "  Chýba doprava.\r\nProsím upraviť.  ",
        revision: 1,
      }).rejectionReason,
    ).toBe("Chýba doprava.\nProsím upraviť.");
    expect(() =>
      assertRejectQuoteRevisionInput({
        actorUserId,
        commandId,
        expectedStateRevision: 1,
        quoteId,
        rejectionReason: "bad\u0000text",
        revision: 1,
      }),
    ).toThrow(TypeError);
  });

  it("validates at the service boundary before persistence", async () => {
    const createDraft = vi.fn().mockResolvedValue({ status: "NOT_FOUND" });
    const persistence = {
      createDraft,
      createRevision: vi.fn(),
      readOwned: vi.fn(),
      readOwnedByInvitation: vi.fn(),
      reject: vi.fn(),
      submit: vi.fn(),
    } as unknown as QuotePersistence;
    const service = createQuoteService({ persistence });
    await expect(
      service.createDraft({
        actorUserId,
        authoringMode: "PLATFORM_STRUCTURED",
        commandId,
        conversationId,
        requestContentRevision: 1,
        requestVisibleVersion: 1,
      }),
    ).resolves.toEqual({ status: "NOT_FOUND" });
    expect(createDraft).toHaveBeenCalledOnce();
    expect(() =>
      assertCreateQuoteDraftInput({
        actorUserId,
        authoringMode: "PLATFORM_STRUCTURED",
        commandId: "invalid",
        conversationId,
        requestContentRevision: 1,
        requestVisibleVersion: 1,
      }),
    ).toThrow(TypeError);
  });

  it("provides a distinct command-id conflict error", () => {
    expect(new QuoteIdempotencyError()).toMatchObject({
      code: "QUOTE_IDEMPOTENCY_CONFLICT",
    });
  });
});
