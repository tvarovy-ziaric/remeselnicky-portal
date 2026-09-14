import type {
  AuditActor,
  AuditAppendResult,
  AuditChanges,
  AuditEvent,
  AuditEventCategory,
  AuditEventDraft,
  AuditRepository,
  AuditTarget,
  SensitiveAccessPurpose,
} from "@portal/audit";
import { assertAuditEventDraft } from "@portal/audit";
import {
  ADMIN_CAPABILITY_VALUES,
  type AdminCapability,
} from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import type { Sql, TransactionSql } from "postgres";

interface AuditEventRow {
  readonly action: string;
  readonly actorCapability: string | null;
  readonly actorKind: "AUTHENTICATED_USER" | "SYSTEM";
  readonly actorSystemReference: string | null;
  readonly actorUserId: UserId | null;
  readonly category: AuditEventCategory;
  readonly changes: AuditChanges;
  readonly contextId: string | null;
  readonly contextType: string | null;
  readonly correlationId: string;
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly reason: string | null;
  readonly sensitiveAccessPurpose: SensitiveAccessPurpose | null;
  readonly targetId: string;
  readonly targetType: string;
}

/**
 * Append-only audit persistence. It intentionally exposes no update/delete or
 * broad read API; authorized investigation projections belong to later admin
 * workflows and must preserve field-level privacy controls.
 */
export function createAuditRepository(
  sql: Sql | TransactionSql,
): AuditRepository {
  return Object.freeze({
    async append(event: AuditEventDraft): Promise<AuditAppendResult> {
      assertAuditEventDraft(event);
      const [inserted] = await sql<AuditEventRow[]>`
        INSERT INTO audit_events (
          event_id,
          correlation_id,
          category,
          actor_kind,
          actor_user_id,
          actor_system_reference,
          actor_capability,
          action_type,
          target_type,
          target_id,
          reason,
          sensitive_access_purpose,
          context_type,
          context_id,
          changes
        ) VALUES (
          ${event.eventId},
          ${event.correlationId},
          ${event.category},
          ${event.actor.kind},
          ${event.actor.kind === "AUTHENTICATED_USER" ? event.actor.userId : null},
          ${event.actor.kind === "SYSTEM" ? event.actor.systemReference : null},
          ${event.actor.kind === "AUTHENTICATED_USER" ? event.actor.capability : null},
          ${event.action},
          ${event.target.type},
          ${event.target.id},
          ${event.reason ?? null},
          ${event.sensitiveAccessPurpose ?? null},
          ${event.context?.type ?? null},
          ${event.context?.id ?? null},
          ${sql.json(event.changes)}
        )
        ON CONFLICT (event_id) DO NOTHING
        RETURNING
          event_id AS "eventId",
          correlation_id AS "correlationId",
          category,
          actor_kind AS "actorKind",
          actor_user_id AS "actorUserId",
          actor_system_reference AS "actorSystemReference",
          actor_capability AS "actorCapability",
          action_type AS action,
          target_type AS "targetType",
          target_id AS "targetId",
          reason,
          sensitive_access_purpose AS "sensitiveAccessPurpose",
          context_type AS "contextType",
          context_id AS "contextId",
          changes,
          occurred_at AS "occurredAt"
      `;
      if (inserted !== undefined) {
        return Object.freeze({
          event: toAuditEvent(inserted),
          status: "APPENDED",
        });
      }

      const [existing] = await sql<AuditEventRow[]>`
        SELECT
          event_id AS "eventId",
          correlation_id AS "correlationId",
          category,
          actor_kind AS "actorKind",
          actor_user_id AS "actorUserId",
          actor_system_reference AS "actorSystemReference",
          actor_capability AS "actorCapability",
          action_type AS action,
          target_type AS "targetType",
          target_id AS "targetId",
          reason,
          sensitive_access_purpose AS "sensitiveAccessPurpose",
          context_type AS "contextType",
          context_id AS "contextId",
          changes,
          occurred_at AS "occurredAt"
        FROM audit_events
        WHERE event_id = ${event.eventId}
      `;
      if (existing === undefined || !sameEvent(existing, event)) {
        throw new Error("Audit event idempotency conflict.");
      }
      return Object.freeze({
        event: toAuditEvent(existing),
        status: "DEDUPLICATED",
      });
    },
  });
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  const actor: AuditActor =
    row.actorKind === "AUTHENTICATED_USER"
      ? {
          capability: requiredCapability(row.actorCapability),
          kind: "AUTHENTICATED_USER",
          userId: required(row.actorUserId, "actor user"),
        }
      : {
          kind: "SYSTEM",
          systemReference: required(row.actorSystemReference, "system actor"),
        };
  const context: AuditTarget | undefined =
    row.contextType === null || row.contextId === null
      ? undefined
      : { id: row.contextId, type: row.contextType };
  return Object.freeze({
    action: row.action,
    actor: Object.freeze(actor),
    category: row.category,
    changes: Object.freeze(row.changes),
    ...(context === undefined ? {} : { context: Object.freeze(context) }),
    correlationId: row.correlationId,
    eventId: row.eventId,
    occurredAt: row.occurredAt,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.sensitiveAccessPurpose === null
      ? {}
      : { sensitiveAccessPurpose: row.sensitiveAccessPurpose }),
    target: Object.freeze({ id: row.targetId, type: row.targetType }),
  });
}

function sameEvent(row: AuditEventRow, draft: AuditEventDraft): boolean {
  const existing = toAuditEvent(row);
  const existingDraft = Object.fromEntries(
    Object.entries(existing).filter(([key]) => key !== "occurredAt"),
  );
  return canonicalJson(existingDraft) === canonicalJson(draft);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Invalid persisted ${name}.`);
  return value;
}

function requiredCapability(value: string | null): AdminCapability {
  const capability = ADMIN_CAPABILITY_VALUES.find(
    (candidate) => candidate === value,
  );
  if (capability === undefined) {
    throw new Error("Invalid persisted actor capability.");
  }
  return capability;
}
