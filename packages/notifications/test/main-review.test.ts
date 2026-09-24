import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  getJobMainReviewNotificationCopy,
  mapDemandSideNotificationEvent,
  mapJobMainReviewNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

const jobId = randomUUID();
const recipientUserId = randomUUID();

function event(
  name: string,
  payload: Readonly<Record<string, boolean | number | string | null>>,
  entityId = jobId,
): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: entityId, type: "JOB" }),
    eventId: randomUUID(),
    idempotencyKey: `review:${randomUUID()}`,
    name,
    occurredAt: new Date("2026-09-15T08:00:00.000Z"),
    payload: Object.freeze({
      direction: "CUSTOMER_TO_PROVIDER",
      job_id: jobId,
      recipient_user_id: recipientUserId,
      ...payload,
    }),
    schemaVersion: 1,
  });
}

describe("main bilateral review notification catalog", () => {
  it("maps an invitation to an important canonical CTA without review content", () => {
    const draft = mapDemandSideNotificationEvent(
      event("job.review.main.invited", {
        submission_deadline_epoch: 1_790_000_000,
      }),
    )?.[0];
    expect(draft).toEqual({
      channels: ["IN_APP", "EMAIL"],
      context: {
        entityId: jobId,
        entityType: "JOB",
        path: `/zakazky/${jobId}`,
      },
      payload: {
        action: "WRITE_MAIN_REVIEW",
        deadline_epoch: 1_790_000_000,
        direction: "CUSTOMER_TO_PROVIDER",
      },
      priority: "IMPORTANT",
      recipientUserId,
      type: "job.review.main.invited",
    });
    expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    expect(JSON.stringify(draft?.payload)).not.toMatch(
      /rating|comment|review_text|address|email|phone/iu,
    );
  });

  it.each(["RECIPROCAL", "DEADLINE"] as const)(
    "maps a %s unlock for the canonical in-app inbox",
    (unlockCause) => {
      const draft = mapJobMainReviewNotificationEvent(
        event("job.review.main.unlocked", { unlock_cause: unlockCause }),
      )?.[0];
      expect(draft).toMatchObject({
        channels: ["IN_APP"],
        context: { path: `/zakazky/${jobId}` },
        payload: {
          action: "READ_MAIN_REVIEWS",
          direction: "CUSTOMER_TO_PROVIDER",
          unlock_cause: unlockCause,
        },
        priority: "INFO",
        type: "job.review.main.unlocked",
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
    },
  );

  it("fails closed on hidden content, incoherent identity and forged state", () => {
    expect(() =>
      mapJobMainReviewNotificationEvent(
        event("job.review.main.invited", {
          ratings: "5",
          submission_deadline_epoch: 1_790_000_000,
        }),
      ),
    ).toThrow(/payload keys/iu);
    expect(() =>
      mapJobMainReviewNotificationEvent(
        event(
          "job.review.main.invited",
          { submission_deadline_epoch: 1_790_000_000 },
          randomUUID(),
        ),
      ),
    ).toThrow(/incoherent/iu);
    expect(() =>
      mapJobMainReviewNotificationEvent(
        event("job.review.main.invited", {
          direction: "SELF_TO_SELF",
          submission_deadline_epoch: 1_790_000_000,
        }),
      ),
    ).toThrow(/direction/iu);
    expect(() =>
      mapJobMainReviewNotificationEvent(
        event("job.review.main.unlocked", { unlock_cause: "READ" }),
      ),
    ).toThrow(/unlock cause/iu);
  });

  it("provides neutral Slovak copy without rating solicitation", () => {
    const invitation = getJobMainReviewNotificationCopy(
      "job.review.main.invited",
    );
    const unlocked = getJobMainReviewNotificationCopy(
      "job.review.main.unlocked",
    );
    expect(invitation.title).toBe("Ohodnoťte dokončenú zákazku");
    expect(invitation.body).toMatch(/dobrovoľné/iu);
    expect(`${invitation.title} ${invitation.body}`).not.toMatch(
      /päť|5.?hviezd|pozitív/iu,
    );
    expect(unlocked.body).toMatch(/pozrieť/iu);
  });

  it("ignores events outside its bounded catalog", () => {
    expect(
      mapJobMainReviewNotificationEvent(event("job.review.other", {})),
    ).toBeUndefined();
  });
});

describe("main bilateral review notification migration", () => {
  it("derives invitations and reciprocal unlocks from authoritative inserts", async () => {
    const migration = await readMigration();
    expect(migration).toContain("AFTER INSERT ON job_completion_decisions");
    expect(migration).toContain("IF NEW.kind <> 'ACCEPT' THEN RETURN NULL");
    expect(migration).toContain(
      "opportunity.completion_kind = 'CUSTOMER_ACCEPTED'",
    );
    expect(migration).toContain("AFTER INSERT ON job_main_review_events");
    expect(migration).toContain("NEW.version <> 1");
    expect(migration).toContain("'RECIPROCAL'");
  });

  it("exposes a bounded non-starving idempotent deadline scan and privacy-minimal events", async () => {
    const migration = await readMigration();
    expect(migration).toContain(
      "enqueue_due_job_main_review_deadline_unlock_notifications",
    );
    expect(migration).toContain("FOR UPDATE OF job SKIP LOCKED");
    expect(migration).toContain("candidate_limit > 500");
    expect(migration).toContain(
      "scan_now := LEAST(candidate_now, clock_timestamp())",
    );
    expect(migration).toContain("main-review:unlocked:CUSTOMER_TO_PROVIDER");
    expect(migration).toContain("main-review:unlocked:PROVIDER_TO_CUSTOMER");
    expect(migration).toMatch(/AND \(NOT EXISTS \([\s\S]+OR NOT EXISTS \(/u);
    expect(migration).toContain("insert_exact_notification_outbox_event(");
    expect(migration).toContain("'job.review.main.invited'");
    expect(migration).toContain("'job.review.main.unlocked'");
    expect(migration).toContain(
      "Upgrades may already contain accepted completions",
    );
    expect(migration).toContain("HAVING count(*) = 2");
    expect(migration).toContain("EXIT WHEN inserted_in_batch = 0");
    expect(migration).not.toMatch(
      /'(?:ratings|comment|review_text|exact_address|phone|email)'/iu,
    );
  });
});

async function readMigration(): Promise<string> {
  return readFile(
    new URL(
      "../../db/migrations/0093_main_review_notifications.sql",
      import.meta.url,
    ),
    "utf8",
  );
}
