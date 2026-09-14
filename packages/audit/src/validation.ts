import {
  AUDIT_DIFF_FIELD_VALUES,
  type AuditActor,
  type AuditChanges,
  type AuditDiffValue,
  type AuditEventDraft,
  type AuditTarget,
} from "./model.js";
import { ADMIN_CAPABILITY_VALUES } from "@portal/admin-auth";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const taxonomyPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u;
const targetTypePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const stableReferencePattern =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/iu;
const symbolicValuePattern = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const unsafeReasonPattern =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\/|bearer\s+\S+|(?:\+?\d[\d ().-]{6,}\d))/iu;
const safeDiffFields = new Set<string>(AUDIT_DIFF_FIELD_VALUES);
const adminCapabilities = new Set<string>(ADMIN_CAPABILITY_VALUES);

export function assertAuditEventDraft(event: AuditEventDraft): void {
  assertUuid(event.eventId, "eventId");
  assertUuid(event.correlationId, "correlationId");
  assertTaxonomy(event.action);
  assertActor(event.actor);
  assertTarget(event.target, "target");
  assertChanges(event.changes);

  if (event.category === "SENSITIVE_ACCESS") {
    if (
      event.sensitiveAccessPurpose === undefined ||
      event.context === undefined
    ) {
      throw new Error(
        "Sensitive access requires a purpose and stable context.",
      );
    }
    assertTarget(event.context, "context");
    assertReason(event.reason, true);
  } else {
    if (
      event.sensitiveAccessPurpose !== undefined ||
      event.context !== undefined
    ) {
      throw new Error(
        "Purpose/context are reserved for sensitive-access events.",
      );
    }
    assertReason(event.reason, event.category === "PRIVILEGED_COMMAND");
  }
}

function assertActor(actor: AuditActor): void {
  if (actor.kind === "AUTHENTICATED_USER") {
    assertUuid(actor.userId, "actor.userId");
    if (!adminCapabilities.has(actor.capability)) {
      throw new Error(
        "Audit actor requires a server-authorized admin capability.",
      );
    }
    return;
  }
  if (!stableReferencePattern.test(actor.systemReference)) {
    throw new Error("System actor requires a bounded stable reference.");
  }
}

function assertTarget(target: AuditTarget, field: string): void {
  if (!targetTypePattern.test(target.type)) {
    throw new Error(`${field}.type must be a stable uppercase taxonomy value.`);
  }
  if (!stableReferencePattern.test(target.id)) {
    throw new Error(
      `${field}.id must be a UUID or namespaced stable reference.`,
    );
  }
}

function assertTaxonomy(action: string): void {
  if (action.length > 96 || !taxonomyPattern.test(action)) {
    throw new Error("Audit action must use a bounded dotted taxonomy.");
  }
}

function assertReason(reason: string | undefined, required: boolean): void {
  if (reason === undefined) {
    if (required) throw new Error("This audit event requires a reason.");
    return;
  }
  if (
    reason !== reason.trim() ||
    reason.length < 8 ||
    reason.length > 500 ||
    unsafeReasonPattern.test(reason)
  ) {
    throw new Error(
      "Audit reason must be bounded and must not contain contact details, URLs or credentials.",
    );
  }
}

function assertChanges(changes: AuditChanges): void {
  for (const [field, change] of Object.entries(changes)) {
    if (!safeDiffFields.has(field) || change === undefined) {
      throw new Error(`Audit diff field is not allowlisted: ${field}`);
    }
    if (Object.keys(change).sort().join(",") !== "after,before") {
      throw new Error(
        `Audit diff ${field} must contain only before and after.`,
      );
    }
    assertDiffValue(change.before, `${field}.before`);
    assertDiffValue(change.after, `${field}.after`);
  }
}

function assertDiffValue(value: AuditDiffValue, field: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && Math.abs(value) <= 999_999_999) return;
  } else if (symbolicValuePattern.test(value)) {
    return;
  }
  throw new Error(`${field} is not a safe symbolic audit value.`);
}

function assertUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new Error(`${field} must be a UUID.`);
}
