import type { UserId } from "@portal/domain";
import type { AdminCapability } from "@portal/admin-auth";

export const AUDIT_EVENT_CATEGORY_VALUES = Object.freeze([
  "PRIVILEGED_COMMAND",
  "SENSITIVE_ACCESS",
  "SECURITY_EVENT",
] as const);
export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORY_VALUES)[number];

export const AUDIT_ACTOR_KIND_VALUES = Object.freeze([
  "AUTHENTICATED_USER",
  "SYSTEM",
] as const);
export type AuditActorKind = (typeof AUDIT_ACTOR_KIND_VALUES)[number];

export const SENSITIVE_ACCESS_PURPOSE_VALUES = Object.freeze([
  "DISPUTE_INVESTIGATION",
  "LEGAL_PRIVACY_REQUEST",
  "MODERATION_REVIEW",
  "SECURITY_INVESTIGATION",
  "SUPPORT_CASE",
] as const);
export type SensitiveAccessPurpose =
  (typeof SENSITIVE_ACCESS_PURPOSE_VALUES)[number];

export const AUDIT_DIFF_FIELD_VALUES = Object.freeze([
  "account_state",
  "credential_state",
  "dispute_state",
  "job_state",
  "message_visibility",
  "profile_state",
  "public_visibility",
  "restriction_state",
  "review_visibility",
  "role",
] as const);
export type AuditDiffField = (typeof AUDIT_DIFF_FIELD_VALUES)[number];
export type AuditDiffValue = boolean | number | string | null;
export interface AuditFieldChange {
  readonly after: AuditDiffValue;
  readonly before: AuditDiffValue;
}
export type AuditChanges = Readonly<
  Partial<Record<AuditDiffField, Readonly<AuditFieldChange>>>
>;

export interface AuthenticatedAuditActor {
  readonly capability: AdminCapability;
  readonly kind: "AUTHENTICATED_USER";
  readonly userId: UserId;
}

export interface SystemAuditActor {
  readonly kind: "SYSTEM";
  readonly systemReference: string;
}

export type AuditActor = AuthenticatedAuditActor | SystemAuditActor;

export interface AuditTarget {
  readonly id: string;
  readonly type: string;
}

export interface AuditEventDraft {
  readonly action: string;
  readonly actor: AuditActor;
  readonly category: AuditEventCategory;
  readonly changes: AuditChanges;
  readonly context?: AuditTarget;
  readonly correlationId: string;
  readonly eventId: string;
  readonly reason?: string;
  readonly sensitiveAccessPurpose?: SensitiveAccessPurpose;
  readonly target: AuditTarget;
}

export interface AuditEvent extends AuditEventDraft {
  readonly occurredAt: Date;
}

export type AuditAppendResult = Readonly<{
  event: AuditEvent;
  status: "APPENDED" | "DEDUPLICATED";
}>;

export interface AuditRepository {
  append(event: AuditEventDraft): Promise<AuditAppendResult>;
}
