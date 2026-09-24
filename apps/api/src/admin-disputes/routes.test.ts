import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_DISPUTE_PATHS, registerAdminDisputeRoutes } from "./routes.js";

const adminId = "a9700000-0000-4000-8000-000000000001" as UserId;
const disputeId = "a9700000-0000-4000-8000-000000000002";
const commandId = "a9700000-0000-4000-8000-000000000003";
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.disputes.manage"]),
  mfaAuthenticatedAt: new Date("2026-09-24T10:00:00.000Z"),
  roles: ["ADMIN"],
  userId: adminId,
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  identity?: "ACTIVE" | "ANONYMOUS";
  csrf?: boolean;
}) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-privileged-session" },
    });
    done();
  });
  const authorize = vi.fn().mockResolvedValue({ status: "AUTHORIZED", actor });
  const applied = vi.fn().mockResolvedValue({
    status: "APPLIED",
    commandId,
    disputeId,
    state: "UNDER_REVIEW",
    recordedAt: new Date("2026-09-24T10:01:00.000Z"),
  });
  const disputes = {
    listQueue: vi.fn().mockResolvedValue([]),
    getCase: vi.fn().mockResolvedValue({ disputeId, conversation: [] }),
    startReview: applied,
    requestInformation: vi.fn().mockResolvedValue({
      status: "APPLIED",
      commandId,
      disputeId,
      state: "WAITING_FOR_PARTY",
      recordedAt: new Date("2026-09-24T10:01:00.000Z"),
    }),
    addInternalNote: applied,
    recordOutcome: applied,
    close: applied,
    reopen: applied,
    setInvestigationHold: vi.fn().mockResolvedValue({
      status: "APPLIED",
      commandId,
      disputeId,
      state: "UNDER_REVIEW",
      recordedAt: new Date("2026-09-24T10:01:00.000Z"),
    }),
    clearInvestigationHold: vi.fn().mockResolvedValue({
      status: "APPLIED",
      commandId,
      disputeId,
      state: "UNDER_REVIEW",
      recordedAt: new Date("2026-09-24T10:01:00.000Z"),
    }),
  };
  registerAdminDisputeRoutes(app, {
    adminAccess: { authorize },
    disputes,
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          input?.identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    csrfProtection: (_request, reply, done) => {
      if (input?.csrf === false) {
        void reply.code(403).send({ code: "CSRF_DENIED" });
        return;
      }
      done();
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return { app, authorize, disputes };
}

function path(template: string): string {
  return template.replace(":disputeId", disputeId);
}

describe("administrative dispute routes", () => {
  it("requires recent MFA and invokes an explicit review command", async () => {
    const { app, authorize, disputes } = fixture();
    const response = await app.inject({
      method: "POST",
      url: path(ADMIN_DISPUTE_PATHS.startReview),
      payload: {
        commandId,
        expectedState: "OPEN",
        reason: "Prípad čaká na administratívne preverenie.",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.disputes.manage",
      requireRecentMfa: true,
      sessionId: "opaque-privileged-session",
      userId: adminId,
    });
    expect(disputes.startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        commandId,
        disputeId,
        expectedState: "OPEN",
      }),
    );
  });

  it("audits sensitive case access through a POST body rather than URL query data", async () => {
    const { app, disputes } = fixture();
    const response = await app.inject({
      method: "POST",
      url: path(ADMIN_DISPUTE_PATHS.access),
      payload: {
        accessId: commandId,
        reason: "Preverenie komunikácie k otvorenému sporu.",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(disputes.getCase).toHaveBeenCalledWith({
      actor,
      privilegedSessionId: "opaque-privileged-session",
      disputeId,
      accessId: commandId,
      reason: "Preverenie komunikácie k otvorenému sporu.",
    });
  });

  it("keeps internal notes on a distinct endpoint and rejects extra fields", async () => {
    const valid = fixture();
    const validResponse = await valid.app.inject({
      method: "POST",
      url: path(ADMIN_DISPUTE_PATHS.internalNotes),
      payload: {
        commandId,
        expectedState: "UNDER_REVIEW",
        reason: "Interný záznam postupu prípadu.",
        note: "Poznámka je určená iba oprávnenému tímu.",
      },
    });
    expect(validResponse.statusCode).toBe(201);
    const invalid = fixture();
    const invalidResponse = await invalid.app.inject({
      method: "POST",
      url: path(ADMIN_DISPUTE_PATHS.internalNotes),
      payload: {
        commandId,
        expectedState: "UNDER_REVIEW",
        reason: "Interný záznam postupu prípadu.",
        note: "Poznámka je určená iba oprávnenému tímu.",
        visibleToParties: true,
      },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalid.disputes.addInternalNote).not.toHaveBeenCalled();
  });

  it("sets and clears a serious-investigation hold through audited named commands", async () => {
    const { app, disputes } = fixture();
    const payload = {
      commandId,
      expectedState: "UNDER_REVIEW",
      reason: "Závažný bezpečnostný signál vyžaduje ďalšie preverenie.",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(ADMIN_DISPUTE_PATHS.setInvestigationHold),
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(disputes.setInvestigationHold).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        disputeId,
        commandId,
        expectedState: "UNDER_REVIEW",
      }),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: path(ADMIN_DISPUTE_PATHS.clearInvestigationHold),
          payload: {
            ...payload,
            reason: "Signál bol preverovaný a hold už nie je potrebný.",
          },
        })
      ).statusCode,
    ).toBe(201);
    expect(disputes.clearInvestigationHold).toHaveBeenCalledOnce();
  });

  it("fails closed for anonymous, CSRF failure and stale MFA", async () => {
    const payload = {
      commandId,
      expectedState: "OPEN",
      reason: "Prípad čaká na administratívne preverenie.",
    };
    const anonymous = fixture({ identity: "ANONYMOUS" });
    expect(
      (
        await anonymous.app.inject({
          method: "POST",
          url: path(ADMIN_DISPUTE_PATHS.startReview),
          payload,
        })
      ).statusCode,
    ).toBe(401);
    const csrf = fixture({ csrf: false });
    expect(
      (
        await csrf.app.inject({
          method: "POST",
          url: path(ADMIN_DISPUTE_PATHS.startReview),
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const denied = fixture();
    denied.authorize.mockResolvedValue({ status: "MFA_TOO_OLD" });
    expect(
      (
        await denied.app.inject({
          method: "POST",
          url: path(ADMIN_DISPUTE_PATHS.startReview),
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.disputes.startReview).not.toHaveBeenCalled();
  });
});
