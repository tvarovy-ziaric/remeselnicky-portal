import { describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import type {
  AuditEventDraft,
  AuditRepository,
  AuthenticatedAuditActor,
} from "../src/index.js";
import {
  assertAuditEventDraft,
  auditActorFromPrivilegedActor,
  createAuditWriter,
} from "../src/index.js";

const actor = Object.freeze({
  capability: "admin.sensitive.read",
  kind: "AUTHENTICATED_USER",
  userId: "10000000-0000-4000-8000-000000000001" as UserId,
}) satisfies AuthenticatedAuditActor;
const privilegedActor = Object.freeze({
  capabilities: new Set([
    "admin.sensitive.read",
    "admin.users.manage",
  ] as const),
  mfaAuthenticatedAt: new Date("2026-01-01T00:00:00Z"),
  roles: ["SUPER_ADMIN"] as const,
  userId: actor.userId,
});
const target = Object.freeze({
  id: "20000000-0000-4000-8000-000000000002",
  type: "CONVERSATION",
});
const eventId = "30000000-0000-4000-8000-000000000003";
const correlationId = "40000000-0000-4000-8000-000000000004";

function repositorySpy() {
  const append = vi.fn<AuditRepository["append"]>((event) =>
    Promise.resolve({
      event: { ...event, occurredAt: new Date("2026-01-01T00:00:00Z") },
      status: "APPENDED",
    }),
  );
  return { append, repository: { append } satisfies AuditRepository };
}

describe("audit writer", () => {
  it("derives user provenance only from a server-authorized privileged actor", () => {
    expect(
      auditActorFromPrivilegedActor(privilegedActor, "admin.sensitive.read"),
    ).toEqual(actor);
    expect(() =>
      auditActorFromPrivilegedActor(privilegedActor, "admin.roles.manage"),
    ).toThrow(/does not hold/u);
  });

  it("records a minimized sensitive-access event with purpose and context", async () => {
    const { append, repository } = repositorySpy();
    const writer = createAuditWriter(repository);

    await writer.recordSensitiveAccess({
      action: "admin.conversation.accessed",
      actor: privilegedActor,
      capability: "admin.sensitive.read",
      context: { id: "case:DISPUTE-42", type: "DISPUTE" },
      correlationId,
      eventId,
      purpose: "DISPUTE_INVESTIGATION",
      reason: "Investigating a reported marketplace dispute",
      target,
    });

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "SENSITIVE_ACCESS",
        changes: {},
        sensitiveAccessPurpose: "DISPUTE_INVESTIGATION",
      }),
    );
    expect(append.mock.calls[0]?.[0]).not.toHaveProperty("occurredAt");
  });

  it("allows only symbolic before/after values on a fixed field allowlist", async () => {
    const { repository } = repositorySpy();
    const writer = createAuditWriter(repository);
    await expect(
      writer.recordPrivilegedCommand({
        action: "admin.user.suspended",
        actor: privilegedActor,
        capability: "admin.users.manage",
        changes: {
          account_state: { after: "SUSPENDED", before: "ACTIVE" },
        },
        correlationId,
        eventId,
        reason: "Policy breach confirmed in support case",
        target: { ...target, type: "USER" },
      }),
    ).resolves.toMatchObject({ status: "APPENDED" });

    const unsafeDraft = {
      action: "admin.user.changed",
      actor,
      category: "PRIVILEGED_COMMAND",
      changes: {
        email: { after: "private@example.test", before: null },
      },
      correlationId,
      eventId,
      reason: "Authorized support correction request",
      target: { ...target, type: "USER" },
    } as unknown as AuditEventDraft;
    expect(() => assertAuditEventDraft(unsafeDraft)).toThrow(
      /not allowlisted/u,
    );
  });

  it.each([
    ["contact detail", "Customer contact is person@example.test"],
    ["phone detail", "Customer called +421 900 111 222 about case"],
    ["URL or signed URL", "Evidence is at https://private.test/file"],
    ["credential", "Bearer abc.def.credential"],
  ])("rejects %s in free-text reasons", (_label, reason) => {
    const draft = {
      action: "admin.user.suspended",
      actor,
      category: "PRIVILEGED_COMMAND",
      changes: {},
      correlationId,
      eventId,
      reason,
      target: { ...target, type: "USER" },
    } satisfies AuditEventDraft;
    expect(() => assertAuditEventDraft(draft)).toThrow(/must not contain/u);
  });

  it("rejects client-like actors, missing reasons and incomplete sensitive context", () => {
    const base = {
      action: "admin.conversation.accessed",
      actor: { ...actor, capability: "user.claimed.admin" },
      category: "SENSITIVE_ACCESS",
      changes: {},
      correlationId,
      eventId,
      reason: "Valid operational investigation reason",
      target,
    } as unknown as AuditEventDraft;
    expect(() => assertAuditEventDraft(base)).toThrow(/server-authorized/u);

    expect(() =>
      assertAuditEventDraft({
        ...base,
        actor,
        category: "PRIVILEGED_COMMAND",
        reason: undefined,
      } as unknown as AuditEventDraft),
    ).toThrow(/requires a reason/u);

    expect(() => assertAuditEventDraft({ ...base, actor })).toThrow(
      /purpose and stable context/u,
    );
  });

  it("supports minimized system security events without privileged reason semantics", async () => {
    const { append, repository } = repositorySpy();
    await createAuditWriter(repository).recordSecurityEvent({
      action: "security.authorization.denied",
      actor: { kind: "SYSTEM", systemReference: "service:api" },
      correlationId,
      eventId,
      target: { id: "route:admin-users", type: "API_ROUTE" },
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: "SYSTEM", systemReference: "service:api" },
        category: "SECURITY_EVENT",
      }),
    );
  });
});
