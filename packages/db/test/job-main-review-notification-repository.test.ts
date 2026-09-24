import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createJobMainReviewNotificationRepository } from "../src/job-main-review-notification-repository.js";

describe("main review notification maintenance repository", () => {
  it("delegates one bounded deadline scan to the durable DB function", async () => {
    const statements: string[] = [];
    const sql = vi.fn((parts: TemplateStringsArray) => {
      statements.push(parts.join("?"));
      return Promise.resolve([{ count: 2 }]);
    });
    const repository = createJobMainReviewNotificationRepository(
      sql as unknown as Sql,
    );

    await expect(repository.enqueueDueDeadlineUnlocks(25)).resolves.toBe(2);
    expect(statements.join("\n")).toContain(
      "enqueue_due_job_main_review_deadline_unlock_notifications",
    );
    expect(sql).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 501, 1.5, Number.NaN])(
    "rejects an invalid scan bound (%s) before querying",
    async (limit) => {
      const sql = vi.fn();
      const repository = createJobMainReviewNotificationRepository(
        sql as unknown as Sql,
      );
      await expect(repository.enqueueDueDeadlineUnlocks(limit)).rejects.toThrow(
        "scan limit",
      );
      expect(sql).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 3, 2.5, Number.NaN])(
    "rejects an impossible affected-event count (%s)",
    async (count) => {
      const sql = vi.fn(() => Promise.resolve([{ count }]));
      const repository = createJobMainReviewNotificationRepository(
        sql as unknown as Sql,
      );
      await expect(repository.enqueueDueDeadlineUnlocks(1)).rejects.toThrow(
        "Invalid main review notification scan result",
      );
    },
  );
});
