import type { JobMainReviewNotificationMaintenanceStore } from "@portal/notifications";
import type { Sql } from "postgres";

interface CountRow {
  readonly count: number;
}

/** Calls the DB-owned exact-once deadline transition scan. */
export function createJobMainReviewNotificationRepository(
  sql: Sql,
): JobMainReviewNotificationMaintenanceStore {
  return Object.freeze({
    async enqueueDueDeadlineUnlocks(limit = 100): Promise<number> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError("Main review deadline scan limit is invalid.");
      }
      const [result] = await sql<CountRow[]>`
        SELECT enqueue_due_job_main_review_deadline_unlock_notifications(
          clock_timestamp(), ${limit}
        )::integer AS count
      `;
      if (
        result === undefined ||
        !Number.isSafeInteger(result.count) ||
        result.count < 0 ||
        result.count > limit * 2
      ) {
        throw new TypeError("Invalid main review notification scan result.");
      }
      return result.count;
    },
  });
}
