import { randomUUID } from "node:crypto";

import {
  createNotificationEmailWorker,
  createNotificationOutboxPublisher,
  getJobMainReviewNotificationCopy,
  JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES,
  mapDemandSideNotificationEvent,
  type CreateNotificationInput,
  type EmailDelivery,
  type EmailDeliveryStore,
  type NotificationRecord,
  type TransactionalEmailRequest,
} from "@portal/notifications";
import type { JobMainReviewContent } from "@portal/db";
import type { OutboxDelivery, PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it, vi } from "vitest";

interface PersistenceState {
  readonly claims: Set<string>;
  readonly email: EmailDelivery[];
  readonly notifications: CreateNotificationInput[];
}

const recordedAt = new Date("2026-09-28T08:00:00.000Z");

describe("R4-031 sealed main-review notification delivery", () => {
  it("keeps a one-sided review canary out of in-app and email material before unlock", async () => {
    const jobId = randomUUID();
    const recipientUserId = randomUUID();
    const sealedComment = `SEALED_COMMENT_${randomUUID()}`;
    const sealedRatingKey = "work_quality";
    const authoritativeOneSidedReview = Object.freeze({
      comment: sealedComment,
      ratings: Object.freeze({
        cleanliness: 5,
        communication: 4,
        price_adherence: 2,
        problem_solving: 1,
        schedule_adherence: 3,
        work_quality: 1,
        would_hire_again: 2,
      }),
      revisedAt: recordedAt,
      revisionId: randomUUID(),
      submittedAt: recordedAt,
      version: 1,
    }) satisfies JobMainReviewContent;
    const committed: PersistenceState = {
      claims: new Set(),
      email: [],
      notifications: [],
    };
    const publisher = createNotificationOutboxPublisher<PersistenceState>({
      claims: {
        claim(transaction, identity) {
          const key = `${identity.consumerName}:${identity.eventId}`;
          if (transaction.claims.has(key)) return Promise.resolve(false);
          transaction.claims.add(key);
          return Promise.resolve(true);
        },
      },
      mapper: mapDemandSideNotificationEvent,
      notifications: {
        create(transaction, input): Promise<NotificationRecord> {
          transaction.notifications.push(input);
          const notificationId = randomUUID();
          if (input.channels.includes("EMAIL")) {
            transaction.email.push({
              attempt: 1,
              context: input.context,
              deliveryId: randomUUID(),
              idempotencyKey: `${input.eventIdempotencyKey}:${input.type}:EMAIL`,
              leaseToken: randomUUID(),
              notificationId,
              notificationType: input.type,
              priority: input.priority,
              recipientUserId: input.recipientUserId,
            });
          }
          return Promise.resolve({
            ...input,
            archivedAt: null,
            createdAt: recordedAt,
            id: notificationId,
            readAt: null,
          });
        },
      },
      transactions: {
        async run(work) {
          const transaction: PersistenceState = {
            claims: new Set(committed.claims),
            email: [...committed.email],
            notifications: [...committed.notifications],
          };
          const result = await work(transaction);
          committed.claims.clear();
          for (const claim of transaction.claims) committed.claims.add(claim);
          committed.email.splice(
            0,
            committed.email.length,
            ...transaction.email,
          );
          committed.notifications.splice(
            0,
            committed.notifications.length,
            ...transaction.notifications,
          );
          return result;
        },
      },
    });

    await publisher.publish(
      delivery(
        reviewEvent(jobId, recipientUserId, {
          submission_deadline_epoch: 1_790_000_000,
        }),
      ),
    );

    expect(authoritativeOneSidedReview).toMatchObject({
      comment: sealedComment,
      ratings: { work_quality: 1 },
    });
    expect(committed.notifications).toHaveLength(1);
    expect(committed.email).toHaveLength(1);
    const persisted = committed.notifications[0];
    expect(persisted).toMatchObject({
      channels: ["IN_APP", "EMAIL"],
      payload: {
        action: "WRITE_MAIN_REVIEW",
        direction: "CUSTOMER_TO_PROVIDER",
      },
      type: JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.invited,
    });
    expect(committed.notifications).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.unlocked,
        }),
      ]),
    );
    const inAppCopy = getJobMainReviewNotificationCopy(
      JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.invited,
    );
    expect(JSON.stringify({ copy: inAppCopy, persisted })).not.toContain(
      sealedComment,
    );
    expect(JSON.stringify({ copy: inAppCopy, persisted })).not.toContain(
      sealedRatingKey,
    );

    const store = emailStore(committed.email[0]);
    const deliveredMaterial: unknown[] = [];
    const worker = createNotificationEmailWorker({
      adapter: {
        deliver(request: TransactionalEmailRequest) {
          if (
            request.notificationType !==
            JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.invited
          ) {
            throw new Error("Unexpected main-review notification type");
          }
          deliveredMaterial.push({
            ...request,
            ...getJobMainReviewNotificationCopy(request.notificationType),
          });
          return Promise.resolve({ status: "SENT" as const });
        },
      },
      backoffMs: () => 1_000,
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      now: () => recordedAt,
      store,
    });
    await expect(worker.processNext()).resolves.toMatchObject({
      status: "SENT",
    });
    expect(deliveredMaterial).toHaveLength(1);
    expect(JSON.stringify(deliveredMaterial)).not.toContain(sealedComment);
    expect(JSON.stringify(deliveredMaterial)).not.toContain(sealedRatingKey);
    expect(deliveredMaterial[0]).not.toHaveProperty("payload");

    const forged = reviewEvent(jobId, recipientUserId, {
      comment: sealedComment,
      ratings: JSON.stringify(authoritativeOneSidedReview.ratings),
      submission_deadline_epoch: 1_790_000_000,
    });
    await expect(publisher.publish(delivery(forged))).rejects.toMatchObject({
      code: "NOTIFICATION_MAPPING_INVALID",
    });
    expect(committed.notifications).toHaveLength(1);
    expect(committed.email).toHaveLength(1);
  });
});

function reviewEvent(
  jobId: string,
  recipientUserId: string,
  extension: Readonly<Record<string, number | string>>,
): PersistedDomainEvent {
  return Object.freeze({
    entity: Object.freeze({ id: jobId, type: "JOB" }),
    eventId: randomUUID(),
    idempotencyKey: `job:${jobId}:main-review:invited:CUSTOMER_TO_PROVIDER`,
    name: JOB_MAIN_REVIEW_NOTIFICATION_EVENT_NAMES.invited,
    occurredAt: recordedAt,
    payload: Object.freeze({
      direction: "CUSTOMER_TO_PROVIDER",
      job_id: jobId,
      recipient_user_id: recipientUserId,
      ...extension,
    }),
    schemaVersion: 1,
  });
}

function delivery(event: PersistedDomainEvent): OutboxDelivery {
  return Object.freeze({
    attempt: 1,
    commandName: "job.review.main.notification",
    correlationId: randomUUID(),
    event,
    leaseToken: randomUUID(),
  });
}

function emailStore(item: EmailDelivery | undefined): EmailDeliveryStore {
  let available = item;
  return {
    claimNextEmail: vi.fn(() => {
      const claimed = available;
      available = undefined;
      return Promise.resolve(claimed);
    }),
    markEmailDelivered: vi.fn(() => Promise.resolve(true)),
    markEmailSent: vi.fn(() => Promise.resolve(true)),
    retryEmail: vi.fn(() => Promise.resolve(true)),
    terminalizeEmail: vi.fn(() => Promise.resolve(true)),
  };
}
