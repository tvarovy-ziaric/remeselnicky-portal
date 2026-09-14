import type {
  AuditChanges,
  AuditEventDraft,
  AuditRepository,
  AuditTarget,
  AuthenticatedAuditActor,
  SensitiveAccessPurpose,
  SystemAuditActor,
} from "./model.js";
import { assertAuditEventDraft } from "./validation.js";
import type { AdminCapability, PrivilegedActor } from "@portal/admin-auth";

interface BaseEventInput {
  readonly action: string;
  readonly correlationId: string;
  readonly eventId: string;
  readonly target: AuditTarget;
}

export interface PrivilegedCommandAuditInput extends BaseEventInput {
  readonly actor: PrivilegedActor;
  readonly capability: AdminCapability;
  readonly changes?: AuditChanges;
  readonly reason: string;
}

export interface SensitiveAccessAuditInput extends BaseEventInput {
  readonly actor: PrivilegedActor;
  readonly capability: AdminCapability;
  readonly context: AuditTarget;
  readonly purpose: SensitiveAccessPurpose;
  readonly reason: string;
}

interface AuthenticatedSecurityEventAuditInput extends BaseEventInput {
  readonly actor: PrivilegedActor;
  readonly capability: AdminCapability;
  readonly reason?: string;
}

interface SystemSecurityEventAuditInput extends BaseEventInput {
  readonly actor: SystemAuditActor;
  readonly reason?: string;
}

export type SecurityEventAuditInput =
  AuthenticatedSecurityEventAuditInput | SystemSecurityEventAuditInput;

export interface AuditWriter {
  recordPrivilegedCommand(
    input: PrivilegedCommandAuditInput,
  ): ReturnType<AuditRepository["append"]>;
  recordSecurityEvent(
    input: SecurityEventAuditInput,
  ): ReturnType<AuditRepository["append"]>;
  recordSensitiveAccess(
    input: SensitiveAccessAuditInput,
  ): ReturnType<AuditRepository["append"]>;
}

/**
 * Converts only a server-established privileged identity into audit actor
 * provenance and fails closed if the command's capability was not authorized.
 * HTTP/client payload models must never expose this constructor input.
 */
export function auditActorFromPrivilegedActor(
  actor: PrivilegedActor,
  capability: AdminCapability,
): AuthenticatedAuditActor {
  if (!actor.capabilities.has(capability)) {
    throw new Error("Privileged actor does not hold the audited capability.");
  }
  return Object.freeze({
    capability,
    kind: "AUTHENTICATED_USER",
    userId: actor.userId,
  });
}

export function createAuditWriter(repository: AuditRepository): AuditWriter {
  const append = (event: AuditEventDraft) => {
    assertAuditEventDraft(event);
    return repository.append(freezeDraft(event));
  };

  return Object.freeze({
    recordPrivilegedCommand(input: PrivilegedCommandAuditInput) {
      return append({
        action: input.action,
        actor: auditActorFromPrivilegedActor(input.actor, input.capability),
        category: "PRIVILEGED_COMMAND",
        changes: input.changes ?? {},
        correlationId: input.correlationId,
        eventId: input.eventId,
        reason: input.reason,
        target: input.target,
      });
    },
    recordSecurityEvent(input: SecurityEventAuditInput) {
      const actor =
        "capability" in input
          ? auditActorFromPrivilegedActor(input.actor, input.capability)
          : input.actor;
      return append({
        action: input.action,
        actor,
        category: "SECURITY_EVENT",
        changes: {},
        correlationId: input.correlationId,
        eventId: input.eventId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        target: input.target,
      });
    },
    recordSensitiveAccess(input: SensitiveAccessAuditInput) {
      return append({
        action: input.action,
        actor: auditActorFromPrivilegedActor(input.actor, input.capability),
        category: "SENSITIVE_ACCESS",
        changes: {},
        context: input.context,
        correlationId: input.correlationId,
        eventId: input.eventId,
        reason: input.reason,
        sensitiveAccessPurpose: input.purpose,
        target: input.target,
      });
    },
  });
}

function freezeDraft(event: AuditEventDraft): AuditEventDraft {
  const changes = Object.fromEntries(
    Object.entries(event.changes).map(([field, value]) => [
      field,
      Object.freeze({ ...value }),
    ]),
  ) as AuditChanges;
  return Object.freeze({
    ...event,
    actor: Object.freeze({ ...event.actor }),
    changes: Object.freeze(changes),
    ...(event.context === undefined
      ? {}
      : { context: Object.freeze({ ...event.context }) }),
    target: Object.freeze({ ...event.target }),
  });
}
