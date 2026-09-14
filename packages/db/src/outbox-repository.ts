import { randomUUID } from "node:crypto";

import type { OutboxWriter, TransactionRunner } from "@portal/commands";
import {
  assertDomainEvent,
  type ClaimOutboxOptions,
  type ConsumerClaimStore,
  type ConsumerEventIdentity,
  type EventPayload,
  type OutboxDelivery,
  type OutboxDeliveryStore,
  type PersistedDomainEvent,
  type RetryOutboxOptions,
} from "@portal/outbox";
import type { Sql, TransactionSql } from "postgres";

export type OutboxDatabaseTransaction = TransactionSql<Record<string, never>>;

export interface OutboxBacklogSnapshot {
  /** PENDING plus PROCESSING events which have not reached a terminal outcome. */
  readonly backlog: number;
  readonly oldestBacklogAgeMs: number | null;
  readonly pending: number;
  readonly processing: number;
  readonly terminal: number;
}

export interface OutboxRepository extends OutboxDeliveryStore {
  readonly consumerClaims: ConsumerClaimStore<OutboxDatabaseTransaction>;
  snapshot(): Promise<OutboxBacklogSnapshot>;
  readonly transactions: TransactionRunner<OutboxDatabaseTransaction>;
  readonly writer: OutboxWriter<OutboxDatabaseTransaction>;
}

interface OutboxDeliveryRow {
  readonly attempt: number;
  readonly commandName: string;
  readonly correlationId: string;
  readonly entityId: string | null;
  readonly entityType: string | null;
  readonly eventId: string;
  readonly eventName: string;
  readonly idempotencyKey: string;
  readonly leaseToken: string;
  readonly occurredAt: Date;
  readonly payload: EventPayload;
  readonly schemaVersion: number;
}

interface MutationRow {
  readonly eventId: string;
}

interface SnapshotRow {
  readonly backlog: number;
  readonly oldestBacklogAgeMs: number | null;
  readonly pending: number;
  readonly processing: number;
  readonly terminal: number;
}

const commandNamePattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const consumerNamePattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const opaqueIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createOutboxRepository(sql: Sql): OutboxRepository {
  const transactions: TransactionRunner<OutboxDatabaseTransaction> =
    Object.freeze({
      run<Result>(
        work: (transaction: OutboxDatabaseTransaction) => Promise<Result>,
      ): Promise<Result> {
        return sql
          .begin(async (transaction) => ({
            value: await work(transaction),
          }))
          .then(({ value }) => value);
      },
    });

  const writer: OutboxWriter<OutboxDatabaseTransaction> = Object.freeze({
    async collect<Event>(
      transaction: OutboxDatabaseTransaction,
      events: readonly Event[],
      context: { readonly commandName: string; readonly correlationId: string },
    ): Promise<void> {
      validateCommandContext(context);
      for (const candidate of events) {
        assertDomainEvent(candidate);
        const entityType = candidate.entity?.type ?? null;
        const entityId = candidate.entity?.id ?? null;
        await transaction`
          INSERT INTO domain_outbox_events (
            event_id,
            idempotency_key,
            event_name,
            schema_version,
            occurred_at,
            entity_type,
            entity_id,
            payload,
            command_name,
            correlation_id,
            available_at
          ) VALUES (
            ${candidate.eventId},
            ${candidate.idempotencyKey},
            ${candidate.name},
            ${candidate.schemaVersion},
            ${candidate.occurredAt},
            ${entityType},
            ${entityId},
            ${transaction.json(candidate.payload)},
            ${context.commandName},
            ${context.correlationId},
            GREATEST(CURRENT_TIMESTAMP, ${candidate.occurredAt})
          )
        `;
      }
    },
  });

  const consumerClaims: ConsumerClaimStore<OutboxDatabaseTransaction> =
    Object.freeze({
      async claim(
        transaction: OutboxDatabaseTransaction,
        identity: ConsumerEventIdentity,
      ): Promise<boolean> {
        validateConsumerIdentity(identity);
        const claimed = await transaction<MutationRow[]>`
          INSERT INTO outbox_consumer_effects (consumer_name, event_id)
          VALUES (${identity.consumerName}, ${identity.eventId})
          ON CONFLICT (consumer_name, event_id) DO NOTHING
          RETURNING event_id AS "eventId"
        `;
        return claimed.length === 1;
      },
    });

  return Object.freeze({
    async claimNext(
      options: ClaimOutboxOptions,
    ): Promise<OutboxDelivery | undefined> {
      assertPositiveInteger(options.leaseDurationMs, "leaseDurationMs");
      const leaseToken = randomUUID();
      const [row] = await sql<OutboxDeliveryRow[]>`
        WITH candidate AS (
          SELECT event_id
          FROM domain_outbox_events
          WHERE
            (status = 'PENDING' AND available_at <= CURRENT_TIMESTAMP)
            OR (status = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP)
          ORDER BY
            CASE WHEN status = 'PROCESSING' THEN lease_expires_at ELSE available_at END,
            occurred_at,
            event_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE domain_outbox_events AS event
        SET
          status = 'PROCESSING',
          attempt_count = event.attempt_count + 1,
          lease_token = ${leaseToken},
          lease_expires_at = CURRENT_TIMESTAMP + (${options.leaseDurationMs} * interval '1 millisecond'),
          updated_at = CURRENT_TIMESTAMP
        FROM candidate
        WHERE event.event_id = candidate.event_id
        RETURNING
          event.event_id AS "eventId",
          event.idempotency_key AS "idempotencyKey",
          event.event_name AS "eventName",
          event.schema_version AS "schemaVersion",
          event.occurred_at AS "occurredAt",
          event.entity_type AS "entityType",
          event.entity_id AS "entityId",
          event.payload,
          event.command_name AS "commandName",
          event.correlation_id AS "correlationId",
          event.attempt_count AS attempt,
          event.lease_token AS "leaseToken"
      `;
      return row === undefined ? undefined : toDelivery(row);
    },
    consumerClaims,
    async markPublished(
      delivery: OutboxDelivery,
      publishedAt: Date,
    ): Promise<boolean> {
      assertValidDate(publishedAt, "publishedAt");
      const rows = await sql<MutationRow[]>`
        UPDATE domain_outbox_events
        SET
          status = 'PUBLISHED',
          published_at = CURRENT_TIMESTAMP,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ${delivery.event.eventId}
          AND status = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING event_id AS "eventId"
      `;
      return rows.length === 1;
    },
    async moveToTerminal(
      delivery: OutboxDelivery,
      errorCode: string,
      failedAt: Date,
    ): Promise<boolean> {
      validateErrorCode(errorCode);
      assertValidDate(failedAt, "failedAt");
      const rows = await sql<MutationRow[]>`
        UPDATE domain_outbox_events
        SET
          status = 'TERMINAL',
          terminal_at = CURRENT_TIMESTAMP,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = ${errorCode},
          updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ${delivery.event.eventId}
          AND status = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING event_id AS "eventId"
      `;
      return rows.length === 1;
    },
    async retry(
      delivery: OutboxDelivery,
      options: RetryOutboxOptions,
    ): Promise<boolean> {
      validateErrorCode(options.errorCode);
      assertValidDate(options.availableAt, "availableAt");
      const rows = await sql<MutationRow[]>`
        UPDATE domain_outbox_events
        SET
          status = 'PENDING',
          available_at = GREATEST(
            CURRENT_TIMESTAMP,
            occurred_at,
            ${options.availableAt}
          ),
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error_code = ${options.errorCode},
          updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ${delivery.event.eventId}
          AND status = 'PROCESSING'
          AND lease_token = ${delivery.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING event_id AS "eventId"
      `;
      return rows.length === 1;
    },
    async snapshot(): Promise<OutboxBacklogSnapshot> {
      const [snapshot] = await sql<SnapshotRow[]>`
        SELECT
          count(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::integer AS backlog,
          count(*) FILTER (WHERE status = 'PENDING')::integer AS pending,
          count(*) FILTER (WHERE status = 'PROCESSING')::integer AS processing,
          count(*) FILTER (WHERE status = 'TERMINAL')::integer AS terminal,
          CASE
            WHEN min(occurred_at) FILTER (
              WHERE status IN ('PENDING', 'PROCESSING')
            ) IS NULL THEN NULL
            ELSE greatest(
              0,
              extract(epoch FROM (
                CURRENT_TIMESTAMP - min(occurred_at) FILTER (
                  WHERE status IN ('PENDING', 'PROCESSING')
                )
              )) * 1000
            )::double precision
          END AS "oldestBacklogAgeMs"
        FROM domain_outbox_events
      `;
      if (snapshot === undefined) {
        throw new Error("Outbox backlog snapshot query returned no row.");
      }
      return Object.freeze({ ...snapshot });
    },
    transactions,
    writer,
  });
}

function toDelivery(row: OutboxDeliveryRow): OutboxDelivery {
  const entity =
    row.entityType === null || row.entityId === null
      ? {}
      : { entity: Object.freeze({ id: row.entityId, type: row.entityType }) };
  const event: PersistedDomainEvent = Object.freeze({
    ...entity,
    eventId: row.eventId,
    idempotencyKey: row.idempotencyKey,
    name: row.eventName,
    occurredAt: row.occurredAt,
    payload: Object.freeze(row.payload),
    schemaVersion: row.schemaVersion,
  });
  return Object.freeze({
    attempt: row.attempt,
    commandName: row.commandName,
    correlationId: row.correlationId,
    event,
    leaseToken: row.leaseToken,
  });
}

function validateCommandContext(context: {
  readonly commandName: string;
  readonly correlationId: string;
}): void {
  if (
    context.commandName.length > 128 ||
    !commandNamePattern.test(context.commandName)
  ) {
    throw new TypeError("commandName must be a stable bounded identifier");
  }
  if (
    context.correlationId.length > 256 ||
    !opaqueIdentifierPattern.test(context.correlationId)
  ) {
    throw new TypeError("correlationId must be an opaque safe identifier");
  }
}

function validateConsumerIdentity(identity: ConsumerEventIdentity): void {
  if (
    identity.consumerName.length > 128 ||
    !consumerNamePattern.test(identity.consumerName)
  ) {
    throw new TypeError("consumerName must be a stable bounded identifier");
  }
  if (!uuidPattern.test(identity.eventId)) {
    throw new TypeError("eventId must be a UUID");
  }
}

function validateErrorCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_.-]{0,63}$/u.test(code)) {
    throw new TypeError("errorCode must be a stable safe identifier");
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new RangeError(`${name} must be a positive bounded integer`);
  }
}
