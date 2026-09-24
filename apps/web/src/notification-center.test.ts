import { describe, expect, it } from "vitest";

import {
  parseNotificationItems,
  parsePreferences,
} from "./notification-center.js";

describe("notification center response validation", () => {
  it("accepts privacy-safe notification cards and preferences", () => {
    const items = parseNotificationItems({
      items: [
        {
          id: "a0000000-0000-4000-8000-000000000001",
          type: "job.confirmed",
          category: "MARKETPLACE",
          title: "Potvrdené",
          body: "Pozrite si detail.",
          priority: "IMPORTANT",
          createdAt: "2026-09-25T08:00:00.000Z",
          readAt: null,
          context: {
            entityType: "JOB",
            entityId: "a0000000-0000-4000-8000-000000000002",
            path: "/zakazky/a0000000-0000-4000-8000-000000000002",
          },
        },
      ],
    });
    expect(items?.length).toBe(1);
    const preferences = parsePreferences({
      preferences: [
        {
          category: "CHAT",
          emailEnabled: false,
          requiredEmailMayOverride: false,
        },
      ],
    });
    expect(preferences?.length).toBe(1);
  });
  it("rejects external/bearer-like paths and malformed preference flags", () => {
    const base = {
      id: "a0000000-0000-4000-8000-000000000001",
      type: "job.confirmed",
      category: "MARKETPLACE",
      title: "x",
      body: "x",
      priority: "IMPORTANT",
      createdAt: "2026-09-25T08:00:00.000Z",
      readAt: null,
      context: {
        entityType: "JOB",
        entityId: "opaque",
        path: "https://example.test/token",
      },
    };
    expect(parseNotificationItems({ items: [base] })).toBeNull();
    expect(
      parsePreferences({
        preferences: [
          {
            category: "CHAT",
            emailEnabled: "false",
            requiredEmailMayOverride: false,
          },
        ],
      }),
    ).toBeNull();
  });
});
