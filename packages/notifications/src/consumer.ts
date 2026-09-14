import type {
  ConsumerClaimStore,
  ConsumerTransactionRunner,
  OutboxDelivery,
  OutboxPublisher,
  PersistedDomainEvent,
} from "@portal/outbox";
import { createIdempotentConsumer, PermanentOutboxError } from "@portal/outbox";

import {
  type NotificationDraft,
  type NotificationRecord,
  validateNotificationDraft,
} from "./model.js";

export interface CreateNotificationInput extends NotificationDraft {
  readonly domainEventId: string;
  readonly eventIdempotencyKey: string;
}

export interface NotificationWriteStore<Transaction> {
  /** Inserts the in-app record and requested channel rows through this transaction. */
  create(
    transaction: Transaction,
    input: CreateNotificationInput,
  ): Promise<NotificationRecord>;
}

export type NotificationEventMapper = (
  event: PersistedDomainEvent,
) => readonly NotificationDraft[] | undefined;

/**
 * Adapts the transactional outbox worker to notifications. The outbox consumer
 * claim and every notification created for one event commit atomically.
 */
export function createNotificationOutboxPublisher<Transaction>(dependencies: {
  readonly claims: ConsumerClaimStore<Transaction>;
  readonly mapper: NotificationEventMapper;
  readonly notifications: NotificationWriteStore<Transaction>;
  readonly transactions: ConsumerTransactionRunner<Transaction>;
}): OutboxPublisher {
  const consumer = createIdempotentConsumer({
    claims: dependencies.claims,
    transactions: dependencies.transactions,
  });

  return Object.freeze({
    async publish(delivery: OutboxDelivery): Promise<void> {
      let drafts: readonly NotificationDraft[] | undefined;
      try {
        drafts = dependencies.mapper(delivery.event);
      } catch {
        throw new PermanentOutboxError("NOTIFICATION_MAPPING_INVALID");
      }
      if (drafts === undefined) return;

      let validated: readonly NotificationDraft[];
      try {
        validated = assertUniqueDrafts(drafts.map(validateNotificationDraft));
      } catch {
        throw new PermanentOutboxError("NOTIFICATION_PAYLOAD_INVALID");
      }

      await consumer.applyOnce(
        {
          consumerName: "notifications.create",
          eventId: delivery.event.eventId,
        },
        async (transaction) => {
          for (const draft of validated) {
            await dependencies.notifications.create(transaction, {
              ...draft,
              domainEventId: delivery.event.eventId,
              eventIdempotencyKey: delivery.event.idempotencyKey,
            });
          }
        },
      );
    },
  });
}

function assertUniqueDrafts(
  drafts: readonly NotificationDraft[],
): readonly NotificationDraft[] {
  const identities = new Set<string>();
  for (const draft of drafts) {
    const identity = `${draft.recipientUserId}:${draft.type}`;
    if (identities.has(identity)) {
      throw new TypeError("event mapper returned a duplicate notification");
    }
    identities.add(identity);
  }
  return drafts;
}
