import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createDemandSideNotificationRepository } from "../src/demand-side-notification-repository.js";

describe("demand-side notification maintenance repository", () => {
  it("uses current DB mute/read-through, a durable watermark and row locks", async () => {
    const statements: string[] = [];
    const transaction = Object.assign(
      vi.fn((parts: TemplateStringsArray) => {
        statements.push(parts.join("?"));
        return Promise.resolve([{ count: 1 }]);
      }),
      { json: (value: unknown) => value },
    );
    const begin = vi.fn((work: (tx: typeof transaction) => unknown) =>
      work(transaction),
    );
    const repository = createDemandSideNotificationRepository(
      Object.assign(vi.fn(), { begin }) as unknown as Sql,
    );

    await expect(repository.enqueueDueUnreadChatEmails()).resolves.toBe(1);
    const query = statements.join("\n");
    expect(query).toContain("NOT state.muted");
    expect(query).toContain(
      "state.latest_notifiable_sequence > state.last_read_sequence",
    );
    expect(query).toContain("state.email_considered_through_sequence");
    expect(query).toContain("FOR UPDATE OF state SKIP LOCKED");
    expect(query).toContain("LIMIT 100");
    expect(query).toContain("conversation.message_received");
    expect(query).not.toMatch(
      /message_text|timeline_entries\.body|exact_address|phone|email_address/iu,
    );
  });

  it.each([-1, 101, 1.5, Number.NaN])(
    "rejects corrupt affected-row counts (%s)",
    async (count) => {
      const transaction = vi.fn(() => Promise.resolve([{ count }]));
      const repository = createDemandSideNotificationRepository(
        Object.assign(vi.fn(), {
          begin: (work: (tx: typeof transaction) => unknown) =>
            work(transaction),
        }) as unknown as Sql,
      );
      await expect(repository.enqueueDueUnreadChatEmails()).rejects.toThrow(
        "Invalid chat notification batch result",
      );
    },
  );
});
