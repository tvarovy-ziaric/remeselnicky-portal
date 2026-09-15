import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_WRITE_IP_LIMIT_MULTIPLIER,
  createDatabaseConversationWriteAdmission,
  type ConversationWriteRateLimitPersistence,
} from "./write-admission.js";

const actor = "9f300000-0000-4000-8000-000000000001";

describe("conversation write admission", () => {
  it("hashes layered account and IP keys before persistence", async () => {
    const consumeRateLimit = vi
      .fn<ConversationWriteRateLimitPersistence["consumeRateLimit"]>()
      .mockResolvedValue({ current: 1 });
    const admission = createDatabaseConversationWriteAdmission({
      accountLimit: 10,
      clock: () => new Date("2026-09-15T12:00:00Z"),
      persistence: { consumeRateLimit },
      timeWindowMs: 60_000,
    });
    await expect(
      admission.admit({
        action: "MESSAGE_SEND",
        actorUserId: actor,
        ip: "203.0.113.10",
      }),
    ).resolves.toBe("ADMITTED");
    expect(consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(consumeRateLimit.mock.calls[0]?.[0]).toMatchObject({
      limit: 10,
      scope: "conversation-write:account",
    });
    expect(consumeRateLimit.mock.calls[1]?.[0]).toMatchObject({
      limit: 10 * CONVERSATION_WRITE_IP_LIMIT_MULTIPLIER,
      scope: "conversation-write:ip",
    });
    expect(JSON.stringify(consumeRateLimit.mock.calls)).not.toMatch(
      /203\.0\.113\.10|9f300000-0000-4000-8000-000000000001/iu,
    );
  });

  it("keeps the account bucket stable across rotating IPs and IP buckets separate", async () => {
    const consumeRateLimit = vi
      .fn<ConversationWriteRateLimitPersistence["consumeRateLimit"]>()
      .mockResolvedValue({ current: 1 });
    const admission = createDatabaseConversationWriteAdmission({
      accountLimit: 10,
      persistence: { consumeRateLimit },
      timeWindowMs: 60_000,
    });
    await admission.admit({
      action: "REPORT",
      actorUserId: actor,
      ip: "203.0.113.10",
    });
    await admission.admit({
      action: "REPORT",
      actorUserId: actor,
      ip: "203.0.113.11",
    });
    expect(consumeRateLimit.mock.calls[0]?.[0].keyDigest).toBe(
      consumeRateLimit.mock.calls[2]?.[0].keyDigest,
    );
    expect(consumeRateLimit.mock.calls[1]?.[0].keyDigest).not.toBe(
      consumeRateLimit.mock.calls[3]?.[0].keyDigest,
    );
  });

  it("fails closed for either exhausted or corrupt layer", async () => {
    const consumed = vi
      .fn<ConversationWriteRateLimitPersistence["consumeRateLimit"]>()
      .mockResolvedValueOnce({ current: 11 })
      .mockResolvedValueOnce({ current: 1 });
    const admission = createDatabaseConversationWriteAdmission({
      accountLimit: 10,
      persistence: { consumeRateLimit: consumed },
      timeWindowMs: 60_000,
    });
    await expect(
      admission.admit({
        action: "ATTACHMENT_UPLOAD",
        actorUserId: actor,
        ip: "203.0.113.10",
      }),
    ).resolves.toBe("RATE_LIMITED");

    const corrupt = createDatabaseConversationWriteAdmission({
      accountLimit: 10,
      persistence: {
        consumeRateLimit: () => Promise.resolve({ current: Number.NaN }),
      },
      timeWindowMs: 60_000,
    });
    await expect(
      corrupt.admit({
        action: "MESSAGE_SEND",
        actorUserId: actor,
        ip: "203.0.113.10",
      }),
    ).rejects.toThrow(TypeError);
  });
});
