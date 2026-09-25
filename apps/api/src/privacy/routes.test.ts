import { randomUUID } from "node:crypto";

import type { UserId } from "@portal/domain";
import type { PrivacyRequestCaseDraft } from "@portal/privacy";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRIVACY_REQUEST_PATHS,
  registerPrivacyRequestRoutes,
} from "./routes.js";

const userId = randomUUID() as UserId;
const now = new Date("2026-09-25T02:00:00.000Z");
const apps: FastifyInstance[] = [];

function build(input?: {
  readonly accountState?: "ACTIVE" | "DEACTIVATED" | "SUSPENDED";
  readonly authenticated?: boolean;
  readonly exportStatus?:
    | "ASSISTED_EXPORT_REQUIRED"
    | "IDENTITY_VERIFICATION_REQUIRED"
    | "NOT_AVAILABLE"
    | "NOT_FOUND"
    | "READY";
}) {
  const accountState = input?.accountState ?? "ACTIVE";
  const listForSubject = vi.fn().mockResolvedValue([
    {
      actionCode: null,
      actorUserId: userId,
      caseId: randomUUID(),
      deadlineAt: null,
      occurredAt: now,
      receivedAt: now,
      requestType: "ACCESS",
      revision: 1,
      state: "RECEIVED",
      subjectUserId: userId,
    },
  ]);
  const hasOpenObligations = vi.fn().mockResolvedValue(true);
  const createForSubject = vi
    .fn()
    .mockImplementation(
      (request: { readonly caseId: string; readonly subjectUserId: UserId }) =>
        Promise.resolve(
          input?.exportStatus !== undefined && input.exportStatus !== "READY"
            ? { status: input.exportStatus }
            : {
                document: {
                  account: {
                    accountState: "ACTIVE",
                    accountStateChangedAt: now.toISOString(),
                    adultAttestedAt: now.toISOString(),
                    createdAt: now.toISOString(),
                    email: "subject@example.test",
                    emailVerifiedAt: now.toISOString(),
                    phone: null,
                    phoneVerifiedAt: null,
                    userId,
                  },
                  consentHistory: [],
                  craftsmanProfile: null,
                  customerProfile: null,
                  exportCase: {
                    caseId: request.caseId,
                    requestRevision: 3,
                    requestState: "IN_REVIEW",
                    requestType: "ACCESS",
                  },
                  generatedAt: now.toISOString(),
                  jobRequestDraftHistory: [],
                  mediaManifest: [],
                  privacyRequestHistory: [],
                  schemaVersion: "1.0",
                  scope: {
                    coverage: "BASE_BUNDLE_REQUIRES_CASE_REVIEW",
                    excludedSecurityMaterial: [
                      "AUTHENTICATION_SECRET_HASHES_AND_TOKENS",
                    ],
                    includedSections: ["ACCOUNT_AND_VERIFIED_CONTACT"],
                    requiredCaseReviewSupplements: [
                      "SHARED_JOB_AND_COMMERCIAL_RECORDS",
                    ],
                  },
                  subjectAuthoredConversationMessages: [],
                },
                status: "READY",
              },
        ),
    );
  const createPrivacyRequestCase = vi
    .fn()
    .mockImplementation((request: PrivacyRequestCaseDraft) =>
      Promise.resolve({
        caseId: request.caseId,
        event: { revision: 1, state: "RECEIVED" },
        receivedAt: now,
        requestType: request.requestType,
        status: "CREATED",
        subjectUserId: userId,
      }),
    );
  const csrfProtection = vi.fn(
    (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ) => {
      if (request.headers["x-csrf-token"] !== "valid") {
        void reply.code(403).send({ code: "CSRF_INVALID" });
        return;
      }
      done();
    },
  );
  const evaluate = vi.fn().mockResolvedValue(
    input?.authenticated === false
      ? { status: "AUTHENTICATION_REQUIRED" }
      : accountState === "ACTIVE"
        ? {
            status: "ACTIVE",
            user: { accountState, id: userId },
          }
        : {
            status: "ACCOUNT_NOT_ACTIVE",
            user: { accountState, id: userId },
          },
  );
  const app = Fastify();
  registerPrivacyRequestRoutes(app, {
    csrfProtection,
    guard: { evaluate },
    operations: { hasOpenObligations, listForSubject },
    privacy: { createPrivacyRequestCase },
    subjectExports: { createForSubject },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return {
    app,
    createPrivacyRequestCase,
    createForSubject,
    evaluate,
    hasOpenObligations,
    listForSubject,
  };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("privacy-request routes", () => {
  it("lists only minimized request state for the session subject", async () => {
    const { app, evaluate, listForSubject } = build();
    const response = await app.inject({
      method: "GET",
      url: PRIVACY_REQUEST_PATHS.requests,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      items: [
        {
          actionCode: null,
          deadlineAt: null,
          requestType: "ACCESS",
          revision: 1,
          state: "RECEIVED",
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /actorUser|subjectUser/u,
    );
    expect(listForSubject).toHaveBeenCalledWith({ subjectUserId: userId });
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), "PRIVACY_REQUEST");
  });

  it("opens a typed case with session ownership and requires CSRF", async () => {
    const fixture = build();
    const payload = {
      caseId: randomUUID(),
      correlationId: randomUUID(),
      eventId: randomUUID(),
      requestType: "ACCOUNT_CLOSURE",
    };
    expect(
      (
        await fixture.app.inject({
          method: "POST",
          url: PRIVACY_REQUEST_PATHS.requests,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const response = await fixture.app.inject({
      method: "POST",
      url: PRIVACY_REQUEST_PATHS.requests,
      headers: { "x-csrf-token": "valid" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(fixture.createPrivacyRequestCase).toHaveBeenCalledWith({
      ...payload,
      subjectUserId: userId,
    });
  });

  it("rejects extra free text instead of storing request bodies in the ledger", async () => {
    const fixture = build();
    const response = await fixture.app.inject({
      method: "POST",
      url: PRIVACY_REQUEST_PATHS.requests,
      headers: { "x-csrf-token": "valid" },
      payload: {
        caseId: randomUUID(),
        correlationId: randomUUID(),
        eventId: randomUUID(),
        requestType: "ERASURE",
        description: "raw personal request body",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(fixture.createPrivacyRequestCase).not.toHaveBeenCalled();
  });

  it("warns about open obligations without exposing Job or dispute IDs", async () => {
    const fixture = build();
    const response = await fixture.app.inject({
      method: "GET",
      url: PRIVACY_REQUEST_PATHS.accountClosureReadiness,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      canRequestClosure: true,
      executionBlockedByOpenObligations: true,
    });
    expect(fixture.hasOpenObligations).toHaveBeenCalledWith(userId);
  });

  it("downloads only the verified subject's explicit structured base bundle", async () => {
    const fixture = build();
    const caseId = randomUUID();
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/me/privacy/requests/${caseId}/export`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="privacy-${caseId}.json"`,
    );
    expect(response.json()).toMatchObject({
      account: { email: "subject@example.test", userId },
      exportCase: { caseId, requestType: "ACCESS" },
      scope: { coverage: "BASE_BUNDLE_REQUIRES_CASE_REVIEW" },
    });
    expect(response.body).not.toMatch(
      /password|sessionId|mfaFactor|actorUserId|storageKey/iu,
    );
    expect(fixture.createForSubject).toHaveBeenCalledWith({
      caseId,
      subjectUserId: userId,
    });
  });

  it("fails closed before identity verification and for oversized assisted exports", async () => {
    const caseId = randomUUID();
    const unverified = build({
      exportStatus: "IDENTITY_VERIFICATION_REQUIRED",
    });
    expect(
      (
        await unverified.app.inject({
          method: "GET",
          url: `/v1/me/privacy/requests/${caseId}/export`,
        })
      ).json(),
    ).toEqual({ code: "IDENTITY_VERIFICATION_REQUIRED" });

    const assisted = build({ exportStatus: "ASSISTED_EXPORT_REQUIRED" });
    const assistedResponse = await assisted.app.inject({
      method: "GET",
      url: `/v1/me/privacy/requests/${caseId}/export`,
    });
    expect(assistedResponse.statusCode).toBe(409);
    expect(assistedResponse.json()).toEqual({
      code: "ASSISTED_EXPORT_REQUIRED",
    });
  });

  it("uses a uniform not-found response for foreign or non-export cases", async () => {
    const fixture = build({ exportStatus: "NOT_FOUND" });
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/me/privacy/requests/${randomUUID()}/export`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "NOT_FOUND" });
  });

  it("keeps rights available to suspended users but not deactivated sessions", async () => {
    const suspended = build({ accountState: "SUSPENDED" });
    expect(
      (
        await suspended.app.inject({
          method: "GET",
          url: PRIVACY_REQUEST_PATHS.requests,
        })
      ).statusCode,
    ).toBe(200);
    const deactivated = build({ accountState: "DEACTIVATED" });
    expect(
      (
        await deactivated.app.inject({
          method: "GET",
          url: PRIVACY_REQUEST_PATHS.requests,
        })
      ).statusCode,
    ).toBe(403);
  });
});
