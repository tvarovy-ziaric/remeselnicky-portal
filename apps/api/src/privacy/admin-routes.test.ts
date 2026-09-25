import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PRIVACY_PATHS,
  registerAdminPrivacyRoutes,
} from "./admin-routes.js";

const adminId = "71000000-0000-4000-8000-000000000001" as UserId;
const subjectId = "71000000-0000-4000-8000-000000000002" as UserId;
const caseId = "71000000-0000-4000-8000-000000000003";
const commandId = "71000000-0000-4000-8000-000000000004";
const occurredAt = new Date("2026-09-25T08:00:00.000Z");
const transitionPath = ADMIN_PRIVACY_PATHS.transition.replace(
  ":caseId",
  caseId,
);
const closurePath = ADMIN_PRIVACY_PATHS.accountClosure.replace(
  ":caseId",
  caseId,
);
const dispositionsPath = ADMIN_PRIVACY_PATHS.dispositions.replace(
  ":caseId",
  caseId,
);
const dispositionDecisionPath = ADMIN_PRIVACY_PATHS.dispositionDecision
  .replace(":caseId", caseId)
  .replace(":category", "ACCOUNT_CORE");
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.privacy.manage"]),
  mfaAuthenticatedAt: occurredAt,
  roles: ["ADMIN"],
  userId: adminId,
};
const transitionBody = {
  actionCode: "IDENTITY_VERIFIED",
  commandId,
  deadlineAt: "2026-10-25T08:00:00.000Z",
  expectedRevision: 1,
  expectedState: "RECEIVED" as const,
  reason: "Overenie identity a rozsahu žiadosti bolo dokončené.",
  resultingState: "VERIFIED" as const,
};
const closureBody = {
  commandId,
  expectedRequestRevision: 3,
  expectedRequestState: "IN_REVIEW" as const,
  reason: "Žiadosť bola overená a nemá otvorené záväzky.",
  reasonCode: "VERIFIED_ACCOUNT_CLOSURE",
  subjectUserId: subjectId,
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  csrf?: boolean;
  identity?: "ACTIVE" | "ANONYMOUS";
}) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-privacy-admin-session" },
    });
    done();
  });
  const authorize = vi.fn().mockResolvedValue({ actor, status: "AUTHORIZED" });
  const listQueue = vi.fn().mockResolvedValue([
    {
      actionCode: null,
      actorUserId: subjectId,
      caseId,
      deadlineAt: null,
      occurredAt,
      receivedAt: occurredAt,
      requestType: "ACCOUNT_CLOSURE",
      revision: 1,
      state: "RECEIVED",
      subjectUserId: subjectId,
    },
  ]);
  const transitionRequest = vi.fn().mockResolvedValue({
    commandId,
    occurredAt,
    revision: 2,
    status: "APPLIED",
    state: "VERIFIED",
  });
  const executeAccountClosure = vi.fn().mockResolvedValue({
    commandId,
    dispositions: [],
    occurredAt,
    requestRevision: 4,
    requestState: "ACTION_REQUIRED",
    status: "APPLIED",
  });
  const disposition = {
    actionCode: "LEGAL_POLICY_REVIEW_REQUIRED",
    actorUserId: adminId,
    category: "ACCOUNT_CORE",
    disposition: "REVIEW_REQUIRED",
    occurredAt,
    policyVersionId: null,
    revision: 1,
    state: "BLOCKED",
  };
  const listDispositions = vi.fn().mockResolvedValue([disposition]);
  const decideDataDisposition = vi.fn().mockResolvedValue({
    commandId,
    disposition: {
      ...disposition,
      actionCode: "ACCOUNT_CORE_RETAINED",
      disposition: "RETAIN",
      policyVersionId: "71000000-0000-4000-8000-000000000005",
      revision: 2,
      state: "COMPLETED",
    },
    status: "APPLIED",
  });
  registerAdminPrivacyRoutes(app, {
    adminAccess: { authorize },
    csrfProtection: (_request, reply, done) => {
      if (input?.csrf === false) {
        void reply.code(403).send({ code: "CSRF_DENIED" });
        return;
      }
      done();
    },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          input?.identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    operations: {
      decideDataDisposition,
      executeAccountClosure,
      listDispositions,
      listQueue,
      transitionRequest,
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return {
    app,
    authorize,
    decideDataDisposition,
    executeAccountClosure,
    listDispositions,
    listQueue,
    transitionRequest,
  };
}

describe("MFA-backed admin privacy operations", () => {
  it("lists the minimized operational queue behind the dedicated capability", async () => {
    const { app, authorize, listQueue } = fixture();
    const response = await app.inject({
      method: "GET",
      url: `${ADMIN_PRIVACY_PATHS.queue}?state=RECEIVED&limit=25`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      items: [
        { caseId, requestType: "ACCOUNT_CLOSURE", subjectUserId: subjectId },
      ],
    });
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.privacy.manage",
      requireRecentMfa: true,
      sessionId: "opaque-privacy-admin-session",
      userId: adminId,
    });
    expect(listQueue).toHaveBeenCalledWith({
      actor,
      limit: 25,
      privilegedSessionId: "opaque-privacy-admin-session",
      state: "RECEIVED",
    });
  });

  it("records an exact request-state transition with admin provenance", async () => {
    const { app, transitionRequest } = fixture();
    const response = await app.inject({
      method: "POST",
      payload: transitionBody,
      url: transitionPath,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      revision: 2,
      state: "VERIFIED",
      status: "APPLIED",
    });
    expect(transitionRequest).toHaveBeenCalledWith({
      ...transitionBody,
      actor,
      caseId,
      deadlineAt: new Date(transitionBody.deadlineAt),
      privilegedSessionId: "opaque-privacy-admin-session",
    });
  });

  it("deactivates only through the account-closure command", async () => {
    const { app, executeAccountClosure } = fixture();
    const response = await app.inject({
      method: "POST",
      payload: closureBody,
      url: closurePath,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      requestState: "ACTION_REQUIRED",
      status: "APPLIED",
    });
    expect(executeAccountClosure).toHaveBeenCalledWith({
      ...closureBody,
      actor,
      caseId,
      privilegedSessionId: "opaque-privacy-admin-session",
    });
  });

  it("lists and records exact category dispositions behind recent MFA", async () => {
    const { app, decideDataDisposition, listDispositions } = fixture();
    const listed = await app.inject({ method: "GET", url: dispositionsPath });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [
        {
          category: "ACCOUNT_CORE",
          disposition: "REVIEW_REQUIRED",
          state: "BLOCKED",
        },
      ],
    });
    expect(listDispositions).toHaveBeenCalledWith({
      actor,
      caseId,
      privilegedSessionId: "opaque-privacy-admin-session",
    });

    const policyVersionId = "71000000-0000-4000-8000-000000000005";
    const body = {
      actionCode: "ACCOUNT_CORE_RETAINED",
      commandId,
      disposition: "RETAIN",
      expectedDisposition: "REVIEW_REQUIRED",
      expectedRevision: 1,
      expectedState: "BLOCKED",
      policyVersionId,
      reason: "Reviewed account-core retention decision.",
    };
    const decided = await app.inject({
      method: "POST",
      payload: body,
      url: dispositionDecisionPath,
    });
    expect(decided.statusCode).toBe(201);
    expect(decided.json()).toMatchObject({
      disposition: {
        disposition: "RETAIN",
        revision: 2,
        state: "COMPLETED",
      },
      status: "APPLIED",
    });
    expect(decideDataDisposition).toHaveBeenCalledWith({
      ...body,
      actor,
      caseId,
      category: "ACCOUNT_CORE",
      privilegedSessionId: "opaque-privacy-admin-session",
    });
  });

  it("fails closed for anonymous, stale MFA, CSRF failure and extra fields", async () => {
    const anonymous = fixture({ identity: "ANONYMOUS" });
    expect(
      (
        await anonymous.app.inject({
          method: "POST",
          payload: transitionBody,
          url: transitionPath,
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.transitionRequest).not.toHaveBeenCalled();

    const denied = fixture();
    denied.authorize.mockResolvedValue({ status: "MFA_TOO_OLD" });
    expect(
      (
        await denied.app.inject({
          method: "POST",
          payload: transitionBody,
          url: transitionPath,
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.transitionRequest).not.toHaveBeenCalled();

    const csrf = fixture({ csrf: false });
    expect(
      (
        await csrf.app.inject({
          method: "POST",
          payload: closureBody,
          url: closurePath,
        })
      ).statusCode,
    ).toBe(403);

    const extra = fixture();
    expect(
      (
        await extra.app.inject({
          method: "POST",
          payload: { ...closureBody, eraseImmediately: true },
          url: closurePath,
        })
      ).statusCode,
    ).toBe(400);
    expect(extra.executeAccountClosure).not.toHaveBeenCalled();

    const extraDisposition = fixture();
    expect(
      (
        await extraDisposition.app.inject({
          method: "POST",
          payload: {
            actionCode: "ACCOUNT_CORE_RETAINED",
            commandId,
            disposition: "RETAIN",
            expectedDisposition: "REVIEW_REQUIRED",
            expectedRevision: 1,
            expectedState: "BLOCKED",
            policyVersionId: "71000000-0000-4000-8000-000000000005",
            reason: "Reviewed account-core retention decision.",
            skipLegalReview: true,
          },
          url: dispositionDecisionPath,
        })
      ).statusCode,
    ).toBe(400);
    expect(extraDisposition.decideDataDisposition).not.toHaveBeenCalled();
  });
});
