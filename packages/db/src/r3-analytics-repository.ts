import { createHash, randomUUID } from "node:crypto";

import {
  R3_ANALYTICS_CONSUMER_NAME,
  assertR3AnalyticsObservationInput,
  type AnalyticsEventName,
  type AnalyticsProfileContext,
  type R3AnalyticsClaim,
  type R3AnalyticsLeaseStore,
  type R3AnalyticsObservationInput,
  type R3AnalyticsObservationPersistence,
  type R3PdfDeliveryObservationPersistence,
  type TrustedAnalyticsCaptureInput,
} from "@portal/analytics";
import type { Sql, TransactionSql } from "postgres";

type RootSql = Sql | TransactionSql;

interface ClaimRow {
  readonly attempt: number;
  readonly eventId: string;
  readonly eventName: string;
  readonly leaseToken: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

interface MutationRow {
  readonly sourceEventId: string;
}

interface ObservationRow {
  readonly actorUserId: string;
  readonly jobRequestId: string;
  readonly kind: string;
  readonly invitationId: string | null;
  readonly payloadFingerprint: string;
  readonly quoteId: string | null;
  readonly quoteRevision: number | null;
}
interface PdfTargetRow {
  readonly jobRequestId: string;
  readonly quoteId: string;
  readonly quoteRevision: number;
}

const SOURCE_PREFIX = "r3.analytics.";
const metadataKeys = new Set([
  "initiator",
  "profile_context",
  "subject_user_id",
  "traffic_class",
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createR3AnalyticsLeaseStore(
  sql: RootSql,
): R3AnalyticsLeaseStore {
  return Object.freeze({
    async claimNext(input: {
      readonly leaseDurationMs: number;
      readonly now: Date;
    }): Promise<R3AnalyticsClaim | undefined> {
      positiveInteger(input.leaseDurationMs, "leaseDurationMs");
      validDate(input.now, "now");
      const leaseToken = randomUUID();
      const [row] = await sql<ClaimRow[]>`
        WITH candidate AS (
          SELECT delivery.source_event_id
          FROM r3_analytics_event_deliveries delivery
          JOIN domain_outbox_events source
            ON source.event_id = delivery.source_event_id
          WHERE source.event_name LIKE 'r3.analytics.%'
            AND ((delivery.state = 'PENDING'
                AND delivery.available_at <= CURRENT_TIMESTAMP)
              OR (delivery.state = 'PROCESSING'
                AND delivery.lease_expires_at <= CURRENT_TIMESTAMP))
          ORDER BY CASE WHEN delivery.state = 'PROCESSING'
              THEN delivery.lease_expires_at ELSE delivery.available_at END,
            source.occurred_at, delivery.source_event_id
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT 1
        )
        UPDATE r3_analytics_event_deliveries AS delivery
        SET state = 'PROCESSING', attempt_count = delivery.attempt_count + 1,
          lease_token = ${leaseToken},
          lease_expires_at = CURRENT_TIMESTAMP
            + (${input.leaseDurationMs} * interval '1 millisecond'),
          last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
        FROM candidate, domain_outbox_events source
        WHERE delivery.source_event_id = candidate.source_event_id
          AND source.event_id = candidate.source_event_id
        RETURNING source.event_id AS "eventId",
          source.event_name AS "eventName", source.occurred_at AS "occurredAt",
          source.payload, delivery.attempt_count AS attempt,
          delivery.lease_token AS "leaseToken"
      `;
      return row === undefined ? undefined : toLease(row);
    },
    markDelivered(lease: R3AnalyticsClaim, at: Date) {
      validDate(at, "at");
      return mutate(sql, lease, "DELIVERED", null);
    },
    markTerminal(
      lease: R3AnalyticsClaim,
      outcome: "INVALID_EVENT" | "TRANSPORT_DISABLED",
      at: Date,
    ) {
      validDate(at, "at");
      return mutate(
        sql,
        lease,
        outcome === "INVALID_EVENT" ? "TERMINAL_INVALID" : "TERMINAL_SKIPPED",
        outcome,
      );
    },
    async retry(
      lease: R3AnalyticsClaim,
      input: {
        readonly at: Date;
        readonly availableAt: Date;
        readonly reason: "TRANSPORT_MISCONFIGURED" | "TRANSPORT_UNAVAILABLE";
      },
    ) {
      validDate(input.at, "at");
      validDate(input.availableAt, "availableAt");
      const rows = await sql<MutationRow[]>`
        UPDATE r3_analytics_event_deliveries
        SET state = 'PENDING', available_at = GREATEST(
            CURRENT_TIMESTAMP, ${input.availableAt}),
          lease_token = NULL, lease_expires_at = NULL,
          last_error_code = ${input.reason}, updated_at = CURRENT_TIMESTAMP
        WHERE source_event_id = ${lease.eventId}
          AND state = 'PROCESSING' AND lease_token = ${lease.leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING source_event_id AS "sourceEventId"
      `;
      return rows.length === 1;
    },
  });
}

export function createR3AnalyticsObservationRepository(
  sql: RootSql,
): R3AnalyticsObservationPersistence {
  return Object.freeze({
    async record(input: R3AnalyticsObservationInput) {
      assertR3AnalyticsObservationInput(input);
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            input.actorUserId,
            input.kind,
            input.invitationId ?? null,
            input.jobRequestId,
            input.quoteId ?? null,
            input.quoteRevision ?? null,
          ]),
        )
        .digest("hex");
      try {
        return await transaction(sql, async (tx) => {
          const existing = await byCommand(tx, input.commandId);
          if (existing !== undefined) {
            assertSameObservation(existing, input, fingerprint);
            return "RECORDED" as const;
          }
          const inserted = await tx<MutationRow[]>`
            INSERT INTO r3_analytics_observation_commands (
              command_id, actor_user_id, observation_kind, job_request_id,
              invitation_id, quote_id, quote_revision, available_quote_count,
              source_event_id, payload_fingerprint, observed_at
            ) VALUES (
              ${input.commandId}, ${input.actorUserId}, ${input.kind},
              ${input.jobRequestId}, ${input.invitationId ?? null},
              ${input.quoteId ?? null},
              ${input.quoteRevision ?? null}, NULL, ${randomUUID()},
              ${fingerprint}, CURRENT_TIMESTAMP
            ) ON CONFLICT DO NOTHING
            RETURNING source_event_id AS "sourceEventId"
          `;
          if (inserted.length === 1) return "RECORDED" as const;
          const collision = await byCommand(tx, input.commandId);
          if (collision !== undefined) {
            assertSameObservation(collision, input, fingerprint);
            return "RECORDED" as const;
          }
          return "UNCHANGED" as const;
        });
      } catch (error) {
        if (isUnavailable(error)) return "NOT_AVAILABLE" as const;
        throw error;
      }
    },
  });
}

export function createR3PdfDeliveryObservationRepository(
  sql: RootSql,
): R3PdfDeliveryObservationPersistence {
  return Object.freeze({
    async recordSuccessfulDelivery(input: {
      readonly actorUserId: string;
      readonly mediaAssetId: string;
    }) {
      if (
        !uuidPattern.test(input.actorUserId) ||
        !uuidPattern.test(input.mediaAssetId)
      ) {
        return;
      }
      try {
        await transaction(sql, async (tx) => {
          const [target] = await tx<PdfTargetRow[]>`
            SELECT invitation.job_request_id AS "jobRequestId",
              quote.id AS "quoteId", content.quote_revision AS "quoteRevision"
            FROM current_quote_external_pdf_content content
            JOIN quote_external_pdf_documents document
              ON document.quote_id = content.quote_id
              AND document.quote_revision = content.quote_revision
              AND document.pdf_media_asset_id = content.pdf_media_asset_id
            JOIN quotes quote ON quote.id = content.quote_id
            JOIN job_invitations invitation ON invitation.id = quote.invitation_id
            WHERE document.pdf_media_asset_id = ${input.mediaAssetId}
            LIMIT 1
          `;
          if (target === undefined) return;
          await createR3AnalyticsObservationRepository(tx).record({
            actorUserId: input.actorUserId,
            commandId: randomUUID(),
            jobRequestId: target.jobRequestId,
            kind: "QUOTE_COMPARISON_PDF_OPENED",
            quoteId: target.quoteId,
            quoteRevision: target.quoteRevision,
          });
        });
      } catch {
        // Post-delivery analytics is intentionally best-effort and private-safe.
      }
    },
  });
}

async function byCommand(
  sql: TransactionSql,
  commandId: string,
): Promise<ObservationRow | undefined> {
  const [row] = await sql<ObservationRow[]>`
    SELECT actor_user_id AS "actorUserId", job_request_id AS "jobRequestId",
      observation_kind AS kind, invitation_id AS "invitationId",
      payload_fingerprint AS "payloadFingerprint",
      quote_id AS "quoteId", quote_revision AS "quoteRevision"
    FROM r3_analytics_observation_commands
    WHERE command_id = ${commandId}
  `;
  return row;
}

function assertSameObservation(
  row: ObservationRow,
  input: R3AnalyticsObservationInput,
  fingerprint: string,
): void {
  if (
    row.actorUserId !== input.actorUserId ||
    row.jobRequestId !== input.jobRequestId ||
    row.kind !== input.kind ||
    row.invitationId !== (input.invitationId ?? null) ||
    row.quoteId !== (input.quoteId ?? null) ||
    row.quoteRevision !== (input.quoteRevision ?? null) ||
    row.payloadFingerprint !== fingerprint
  ) {
    throw new Error("analytics command id was reused for different intent");
  }
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    /analytics observation unavailable|duplicate key/u.test(error.message)
  );
}

async function mutate(
  sql: RootSql,
  lease: R3AnalyticsClaim,
  state: "DELIVERED" | "TERMINAL_INVALID" | "TERMINAL_SKIPPED",
  error: string | null,
): Promise<boolean> {
  return transaction(sql, async (tx) => {
    const rows = await tx<MutationRow[]>`
      UPDATE r3_analytics_event_deliveries
      SET state = ${state}, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = ${error},
        delivered_at = CASE WHEN ${state} = 'DELIVERED'
          THEN CURRENT_TIMESTAMP ELSE NULL END,
        terminal_at = CASE WHEN ${state} <> 'DELIVERED'
          THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
      WHERE source_event_id = ${lease.eventId}
        AND state = 'PROCESSING' AND lease_token = ${lease.leaseToken}
        AND lease_expires_at > CURRENT_TIMESTAMP
      RETURNING source_event_id AS "sourceEventId"
    `;
    if (rows.length !== 1) return false;
    if (state === "DELIVERED") {
      const claimed = await tx<MutationRow[]>`
        INSERT INTO outbox_consumer_effects (consumer_name, event_id)
        VALUES (${R3_ANALYTICS_CONSUMER_NAME}, ${lease.eventId})
        ON CONFLICT (consumer_name, event_id) DO NOTHING
        RETURNING event_id AS "sourceEventId"
      `;
      if (claimed.length !== 1) {
        throw new Error("analytics delivered effect already exists");
      }
    }
    return true;
  });
}

function toLease(row: ClaimRow): R3AnalyticsClaim {
  if (!uuidPattern.test(row.eventId) || !uuidPattern.test(row.leaseToken)) {
    throw new TypeError("analytics lease identifiers are invalid");
  }
  const common = Object.freeze({
    attempt: positiveInteger(row.attempt, "attempt"),
    eventId: row.eventId,
    leaseToken: row.leaseToken,
  });
  try {
    const payload = plainObject(row.payload);
    const subjectUserId = requiredString(
      payload.subject_user_id,
      "subject_user_id",
    );
    const profileContext = profile(payload.profile_context);
    const traffic = requiredString(payload.traffic_class, "traffic_class");
    if (traffic !== "REAL" && traffic !== "INTERNAL" && traffic !== "TEST") {
      throw new TypeError("analytics traffic class is invalid");
    }
    const initiator = requiredString(payload.initiator, "initiator");
    if (initiator !== "USER" && initiator !== "SYSTEM") {
      throw new TypeError("analytics initiator is invalid");
    }
    const { eventName, schemaVersion } = mapSourceName(row.eventName);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!metadataKeys.has(key)) properties[key] = value;
    }
    const observation: TrustedAnalyticsCaptureInput = Object.freeze({
      event_id: row.eventId,
      event_name: eventName,
      occurred_at: validDate(row.occurredAt, "occurredAt"),
      properties: Object.freeze(properties),
      schema_version: schemaVersion,
      subject: Object.freeze({
        is_internal: traffic === "INTERNAL",
        is_test: traffic === "TEST",
        kind: "ACTOR" as const,
        profile_context: profileContext,
        user_id: subjectUserId,
      }),
    });
    return Object.freeze({ ...common, kind: "VALID" as const, observation });
  } catch {
    return Object.freeze({ ...common, kind: "INVALID" as const });
  }
}

function mapSourceName(value: string): {
  eventName: AnalyticsEventName;
  schemaVersion: number;
} {
  if (!value.startsWith(SOURCE_PREFIX)) {
    throw new TypeError("analytics source event is not owned by R3");
  }
  const raw = value.slice(SOURCE_PREFIX.length);
  if (raw === "job_request_submitted_v2") {
    return { eventName: "job_request_submitted", schemaVersion: 2 };
  }
  if (raw === "quote_submitted_v2") {
    return { eventName: "quote_submitted", schemaVersion: 2 };
  }
  return { eventName: raw as AnalyticsEventName, schemaVersion: 1 };
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("analytics source payload must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function profile(value: unknown): AnalyticsProfileContext {
  if (value !== "CUSTOMER" && value !== "CRAFTSMAN" && value !== "BOTH") {
    throw new TypeError("profile_context is invalid");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
  return value;
}

function transaction<Result>(
  sql: RootSql,
  callback: (tx: TransactionSql) => Promise<Result>,
): Promise<Result> {
  if ("begin" in sql) {
    return sql
      .begin(async (tx) => ({ value: await callback(tx) }))
      .then((x) => x.value);
  }
  return callback(sql);
}
