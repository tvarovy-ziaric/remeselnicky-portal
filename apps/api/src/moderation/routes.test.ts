import type { PrivilegedActor } from "@portal/admin-auth";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_MODERATION_PATHS,
  MODERATION_ACTIONS_PATH,
  MODERATION_APPEAL_PATH,
  registerAdminModerationRoutes,
  registerModerationAppealRoutes,
} from "./routes.js";

const adminId = "aa230000-0000-4000-8000-000000000001" as UserId;
const userId = "aa230000-0000-4000-8000-000000000002" as UserId;
const reportId = "aa230000-0000-4000-8000-000000000003";
const commandId = "aa230000-0000-4000-8000-000000000004";
const actionId = "aa230000-0000-4000-8000-000000000005";
const appealId = "aa230000-0000-4000-8000-000000000006";
const recordedAt = new Date("2026-09-24T10:00:00.000Z");
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.reviews.moderate"]),
  mfaAuthenticatedAt: recordedAt,
  roles: ["ADMIN"],
  userId: adminId,
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function adminFixture(options?: { authorize?: boolean }) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId: "opaque-privileged-session" },
    });
    done();
  });
  const authorize = vi
    .fn()
    .mockResolvedValue(
      options?.authorize === false
        ? { status: "MFA_TOO_OLD" }
        : { status: "AUTHORIZED", actor },
    );
  const applied = vi.fn().mockResolvedValue({
    status: "APPLIED",
    commandId,
    reportId,
    state: "ACTIONED",
    recordedAt,
  });
  const moderation = {
    listQueue: vi.fn().mockResolvedValue([]),
    listAppeals: vi.fn().mockResolvedValue([]),
    getReport: vi.fn().mockResolvedValue({ reportId, actions: [] }),
    getAppeal: vi.fn().mockResolvedValue({ appealId, actionId }),
    startReview: applied,
    findNoViolation: applied,
    warn: applied,
    hideContent: applied,
    excludeReviewEvidence: applied,
    restrictFeature: applied,
    suspendTemporarily: applied,
    suspendIndefinitely: applied,
    close: applied,
    reopen: applied,
    decideAppeal: vi.fn().mockResolvedValue({
      status: "APPLIED",
      commandId,
      appealId,
      state: "REVERSED",
      recordedAt,
    }),
  };
  registerAdminModerationRoutes(app, {
    adminAccess: { authorize },
    moderation,
    guard: {
      evaluate: vi.fn().mockResolvedValue({
        status: "ACTIVE",
        user: { id: adminId },
      }),
    },
    csrfProtection: (_request, _reply, done) => done(),
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return { app, authorize, moderation };
}

function reportPath(template: string): string {
  return template.replace(":reportId", reportId);
}

describe("administrative moderation routes", () => {
  it("requires recent MFA and invokes a named start-review command", async () => {
    const { app, authorize, moderation } = adminFixture();
    const response = await app.inject({
      method: "POST",
      url: reportPath(ADMIN_MODERATION_PATHS.startReview),
      payload: {
        commandId,
        expectedState: "OPEN",
        reason: "Začatie manuálneho preverenia hlásenia.",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.reviews.moderate",
      requireRecentMfa: true,
      sessionId: "opaque-privileged-session",
      userId: adminId,
    });
    expect(moderation.startReview).toHaveBeenCalledWith(
      expect.objectContaining({ actor, commandId, reportId }),
    );
  });

  it("accepts an explicit content hide and rejects an extra sanction field", async () => {
    const valid = adminFixture();
    const payload = {
      commandId,
      expectedState: "UNDER_REVIEW",
      reason: "Potvrdené porušenie pravidiel obsahu.",
      policyCategory: "PERSONAL_DATA_PRIVACY",
      policyReasonCode: "EXACT_ADDRESS_DISCLOSURE",
      policyVersion: "ALPHA-1",
      subjectUserId: userId,
      enforcementScope: "CONTENT",
      userFacingReason: "Obsah bol skrytý pre porušenie súkromia.",
      priorState: { visibility: "VISIBLE" },
    };
    const response = await valid.app.inject({
      method: "POST",
      url: reportPath(ADMIN_MODERATION_PATHS.hideContent),
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(valid.moderation.hideContent).toHaveBeenCalledWith(
      expect.objectContaining({ enforcementScope: "CONTENT" }),
    );

    const invalid = adminFixture();
    const invalidResponse = await invalid.app.inject({
      method: "POST",
      url: reportPath(ADMIN_MODERATION_PATHS.hideContent),
      payload: { ...payload, deletePermanently: true },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalid.moderation.hideContent).not.toHaveBeenCalled();

    const wrongScope = adminFixture();
    const wrongScopeResponse = await wrongScope.app.inject({
      method: "POST",
      url: reportPath(ADMIN_MODERATION_PATHS.hideContent),
      payload: { ...payload, enforcementScope: "MESSAGING" },
    });
    expect(wrongScopeResponse.statusCode).toBe(400);
    expect(wrongScope.moderation.hideContent).not.toHaveBeenCalled();
  });

  it("fails closed when the recent MFA authority is unavailable", async () => {
    const { app, moderation } = adminFixture({ authorize: false });
    const response = await app.inject({
      method: "POST",
      url: reportPath(ADMIN_MODERATION_PATHS.startReview),
      payload: {
        commandId,
        expectedState: "OPEN",
        reason: "Začatie manuálneho preverenia hlásenia.",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(moderation.startReview).not.toHaveBeenCalled();
  });

  it("uses a separate named appeal reversal endpoint", async () => {
    const { app, moderation } = adminFixture();
    const response = await app.inject({
      method: "POST",
      url: ADMIN_MODERATION_PATHS.appealReverse.replace(":appealId", appealId),
      payload: {
        commandId,
        expectedState: "OPEN",
        reason: "Nové dôkazy vyvrátili pôvodný záver.",
        policyReasonCode: "NEW_EVIDENCE_CORRECTION",
        policyVersion: "ALPHA-1",
        userFacingReason: "Pôvodné opatrenie bolo po preskúmaní zrušené.",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(moderation.decideAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "REVERSE", appealId }),
    );
  });
});

describe("moderation appeal route", () => {
  it("allows only the affected authenticated user to submit a separate appeal", async () => {
    const app = Fastify();
    apps.push(app);
    const submitAppeal = vi.fn().mockResolvedValue({
      status: "APPLIED",
      appealId,
      state: "OPEN",
      submittedAt: recordedAt,
    });
    registerModerationAppealRoutes(app, {
      moderation: {
        listMyActions: vi.fn().mockResolvedValue([]),
        submitAppeal,
      },
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACTIVE",
          user: { id: userId },
        }),
      },
      csrfProtection: (_request, _reply, done) => done(),
      rateLimit: { max: 10, timeWindowMs: 60_000 },
    });
    const response = await app.inject({
      method: "POST",
      url: MODERATION_APPEAL_PATH.replace(":actionId", actionId),
      payload: {
        appealId,
        explanation: "Žiadam o opätovné posúdenie rozhodnutia.",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(submitAppeal).toHaveBeenCalledWith({
      actorUserId: userId,
      actionId,
      appealId,
      explanation: "Žiadam o opätovné posúdenie rozhodnutia.",
    });
  });

  it("keeps the appeal path available to the affected suspended account", async () => {
    const app = Fastify();
    apps.push(app);
    const listMyActions = vi.fn().mockResolvedValue([]);
    registerModerationAppealRoutes(app, {
      moderation: {
        listMyActions,
        submitAppeal: vi.fn(),
      },
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACCOUNT_NOT_ACTIVE",
          user: { accountState: "SUSPENDED", id: userId },
        }),
      },
      csrfProtection: (_request, _reply, done) => done(),
      rateLimit: { max: 10, timeWindowMs: 60_000 },
    });
    const response = await app.inject({
      method: "GET",
      url: MODERATION_ACTIONS_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(listMyActions).toHaveBeenCalledWith(userId);
  });

  it("does not reopen moderation data access for a deactivated account", async () => {
    const app = Fastify();
    apps.push(app);
    const listMyActions = vi.fn();
    registerModerationAppealRoutes(app, {
      moderation: { listMyActions, submitAppeal: vi.fn() },
      guard: {
        evaluate: vi.fn().mockResolvedValue({
          status: "ACCOUNT_NOT_ACTIVE",
          user: { accountState: "DEACTIVATED", id: userId },
        }),
      },
      csrfProtection: (_request, _reply, done) => done(),
      rateLimit: { max: 10, timeWindowMs: 60_000 },
    });
    const response = await app.inject({
      method: "GET",
      url: MODERATION_ACTIONS_PATH,
    });
    expect(response.statusCode).toBe(403);
    expect(listMyActions).not.toHaveBeenCalled();
  });
});
