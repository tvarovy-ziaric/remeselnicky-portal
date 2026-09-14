import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  validateNotificationDraft,
  validatePrivacySafePayload,
} from "../src/index.js";

function validDraft() {
  return {
    channels: ["IN_APP", "EMAIL"] as const,
    context: {
      entityId: randomUUID(),
      entityRevision: 3,
      entityType: "CHANGE_ORDER",
      path: `/jobs/${randomUUID()}/changes/${randomUUID()}/revisions/3`,
    },
    payload: { action: "REVIEW_REQUIRED", deadline_epoch: 1_789_000_000 },
    priority: "IMPORTANT" as const,
    recipientUserId: randomUUID(),
    type: "change_order.review_requested",
  };
}

describe("notification model", () => {
  it("accepts a stable privacy-minimal notification envelope", () => {
    expect(validateNotificationDraft(validDraft())).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      priority: "IMPORTANT",
      type: "change_order.review_requested",
    });
  });

  it("requires the canonical in-app inbox even when email is requested", () => {
    expect(() =>
      validateNotificationDraft({ ...validDraft(), channels: ["EMAIL"] }),
    ).toThrow("in-app is the canonical notification channel");
  });

  it.each([
    { payload: { exact_address: "Main:12" }, reason: "key" },
    { payload: { message_text: "hello" }, reason: "key" },
    { payload: { review_text: "sealed" }, reason: "key" },
    { payload: { token: "secret" }, reason: "key" },
    { payload: { safe_preview: "a sentence with spaces" }, reason: "value" },
    { payload: { nested: { private: "data" } }, reason: "value" },
  ])("rejects sensitive/content-bearing payloads ($reason)", ({ payload }) => {
    expect(() => validatePrivacySafePayload(payload as never)).toThrow();
  });

  it.each([
    "/jobs/id?token=secret",
    "https://outside.test/jobs/id",
    "/jobs//id",
    "/jobs/id#private",
  ])("rejects unsafe or bearer-like deep links: %s", (path) => {
    expect(() =>
      validateNotificationDraft({
        ...validDraft(),
        context: { ...validDraft().context, path },
      }),
    ).toThrow("safe relative application path");
  });
});
