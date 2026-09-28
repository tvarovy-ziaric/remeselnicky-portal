import type { PrivilegedActor } from "@portal/admin-auth";
import { CredentialClaimIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_CREDENTIAL_REVIEW_PATHS,
  registerAdminCredentialReviewRoutes,
} from "./routes.js";

const adminId = "c1000000-0000-4000-8000-000000000001" as UserId;
const otherId = "c1000000-0000-4000-8000-000000000002" as UserId;
const claimId = "c1000000-0000-4000-8000-000000000003";
const profileId = "c1000000-0000-4000-8000-000000000004";
const professionId = "c1000000-0000-4000-8000-000000000005";
const evidenceId = "c1000000-0000-4000-8000-000000000006";
const otherEvidenceId = "c1000000-0000-4000-8000-000000000007";
const commandId = "c1000000-0000-4000-8000-000000000008";
const sessionId = "opaque-admin-credential-session";
const now = new Date("2026-09-28T15:00:00.000Z");
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.credentials.review"]),
  mfaAuthenticatedAt: now,
  roles: ["ADMIN"],
  userId: adminId,
};
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  readonly csrf?: boolean;
  readonly identity?: "ACTIVE" | "ANONYMOUS" | "INACTIVE";
}) {
  const app = Fastify();
  apps.push(app);
  app.addHook("onRequest", (request, _reply, done) => {
    Object.defineProperty(request, "session", {
      configurable: true,
      value: { sessionId },
    });
    done();
  });
  const authorize = vi.fn().mockResolvedValue({ actor, status: "AUTHORIZED" });
  const listPending = vi.fn().mockResolvedValue({
    items: [reviewItem()],
    nextCursor: null,
  });
  const findReviewable = vi.fn().mockResolvedValue(reviewItem());
  const review = vi.fn().mockResolvedValue(reviewResult("APPROVED"));
  const handleDownload = vi.fn().mockResolvedValue({
    headers: {
      "cache-control": "private, no-store",
      location: "https://private-storage.invalid/credential?signature=opaque",
      "referrer-policy": "no-referrer",
    },
    statusCode: 303,
  });
  registerAdminCredentialReviewRoutes(app, {
    adminAccess: { authorize },
    credentialReview: { review },
    csrfProtection: (_request, reply, done) => {
      if (input?.csrf === false) {
        void reply.code(403).send({ code: "CSRF_DENIED" });
        return;
      }
      done();
    },
    evidenceDelivery: { handleDownload },
    guard: {
      evaluate: vi
        .fn()
        .mockResolvedValue(
          input?.identity === "ANONYMOUS"
            ? { status: "AUTHENTICATION_REQUIRED" }
            : input?.identity === "INACTIVE"
              ? { status: "ACCOUNT_NOT_ACTIVE" }
              : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
    reviews: { findReviewable, listPending },
  });
  return {
    app,
    authorize,
    findReviewable,
    handleDownload,
    listPending,
    review,
  };
}

describe("administrative credential review routes", () => {
  it("lists only the privacy-minimal bounded PENDING DTO with recent MFA", async () => {
    const context = fixture();
    const response = await context.app.inject({
      method: "GET",
      url: `${ADMIN_CREDENTIAL_REVIEW_PATHS.queue}?limit=20`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(context.authorize).toHaveBeenCalledWith({
      capability: "admin.credentials.review",
      requireRecentMfa: true,
      sessionId,
      userId: adminId,
    });
    expect(context.listPending).toHaveBeenCalledWith({ limit: 20 });
    expect(response.json()).toEqual({
      items: [serializedReviewItem()],
      nextCursor: null,
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /email|phone|address|ownerUserId|reviewReason|session|mfa|audit/iu,
    );
  });

  it("fails closed for anonymous, inactive, old-MFA, incapable, and mismatched actors", async () => {
    for (const identity of ["ANONYMOUS", "INACTIVE"] as const) {
      const context = fixture({ identity });
      const response = await context.app.inject({
        method: "GET",
        url: ADMIN_CREDENTIAL_REVIEW_PATHS.queue,
      });
      expect(response.statusCode).toBe(identity === "ANONYMOUS" ? 401 : 403);
      expect(context.listPending).not.toHaveBeenCalled();
    }

    for (const decision of [
      { status: "MFA_TOO_OLD" },
      {
        actor: { ...actor, capabilities: new Set(["admin.access"]) },
        status: "AUTHORIZED",
      },
      { actor: { ...actor, userId: otherId }, status: "AUTHORIZED" },
    ]) {
      const context = fixture();
      context.authorize.mockResolvedValue(decision);
      const response = await context.app.inject({
        method: "GET",
        url: ADMIN_CREDENTIAL_REVIEW_PATHS.queue,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "PRIVILEGED_ACCESS_DENIED" });
      expect(context.listPending).not.toHaveBeenCalled();
    }
  });

  it("withholds a queue projection when privileged access is revoked during the read", async () => {
    const context = fixture();
    context.authorize
      .mockResolvedValueOnce({ actor, status: "AUTHORIZED" })
      .mockResolvedValueOnce({ status: "SESSION_REVOKED" });
    const response = await context.app.inject({
      method: "GET",
      url: ADMIN_CREDENTIAL_REVIEW_PATHS.queue,
    });

    expect(context.listPending).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "PRIVILEGED_ACCESS_DENIED" });
    expect(response.body).not.toContain(claimId);
  });

  it("sends exact approve, reject, and revoke commands to the governed review service", async () => {
    const cases = [
      {
        decision: "APPROVE",
        path: ADMIN_CREDENTIAL_REVIEW_PATHS.approve,
        payload: approveBody(),
        state: "APPROVED",
      },
      {
        decision: "REJECT",
        path: ADMIN_CREDENTIAL_REVIEW_PATHS.reject,
        payload: reasonBody(
          "Evidence does not prove the claimed qualification.",
        ),
        state: "REJECTED",
      },
      {
        decision: "REVOKE",
        path: ADMIN_CREDENTIAL_REVIEW_PATHS.revoke,
        payload: reasonBody(
          "The issuing authority has withdrawn this qualification.",
        ),
        state: "REVOKED",
      },
    ] as const;

    for (const testCase of cases) {
      const context = fixture();
      context.review.mockResolvedValue(reviewResult(testCase.state));
      const response = await context.app.inject({
        method: "POST",
        url: testCase.path.replace(":claimId", claimId),
        payload: testCase.payload,
      });

      expect(response.statusCode).toBe(201);
      expect(context.review).toHaveBeenCalledWith({
        actorUserId: adminId,
        privilegedSessionId: sessionId,
        command: {
          claimId,
          commandId,
          decision: testCase.decision,
          expectedRevision: 2,
          ...(testCase.decision === "APPROVE"
            ? {}
            : {
                reason: testCase.payload.reason,
                reasonCategory: "INSUFFICIENT_EVIDENCE",
              }),
        },
      });
      expect(response.json()).toEqual({
        claim: {
          claimId,
          reviewReason:
            testCase.decision === "APPROVE" ? null : testCase.payload.reason,
          reviewReasonCategory:
            testCase.decision === "APPROVE" ? null : "INSUFFICIENT_EVIDENCE",
          reviewedAt: now.toISOString(),
          revision: 3,
          state: testCase.state,
        },
        status: "APPLIED",
      });
    }
  });

  it("maps deduplication and domain denials without exposing command input", async () => {
    const deduplicated = fixture();
    deduplicated.review.mockResolvedValue({
      ...reviewResult("APPROVED"),
      status: "DEDUPLICATED",
    });
    const replay = await deduplicated.app.inject({
      method: "POST",
      url: ADMIN_CREDENTIAL_REVIEW_PATHS.approve.replace(":claimId", claimId),
      payload: approveBody(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: "DEDUPLICATED" });

    for (const [status, code, responseCode] of [
      ["AUTHORIZATION_DENIED", "PRIVILEGED_ACCESS_DENIED", 403],
      ["CLAIM_UNAVAILABLE", "NOT_FOUND", 404],
      ["STALE_REVISION", "STALE_REVISION", 409],
      ["INVALID_TRANSITION", "INVALID_TRANSITION", 409],
      ["REQUIRED_EVIDENCE_MISSING", "REQUIRED_EVIDENCE_MISSING", 409],
    ] as const) {
      const context = fixture();
      context.review.mockResolvedValue({ status });
      const response = await context.app.inject({
        method: "POST",
        url: ADMIN_CREDENTIAL_REVIEW_PATHS.approve.replace(":claimId", claimId),
        payload: approveBody(),
      });
      expect(response.statusCode).toBe(responseCode);
      expect(response.json()).toEqual({ code });
      expect(JSON.stringify(response.json())).not.toContain(commandId);
    }
  });

  it("rejects CSRF failures and malformed or expanded command bodies", async () => {
    const csrf = fixture({ csrf: false });
    const csrfResponse = await csrf.app.inject({
      method: "POST",
      url: ADMIN_CREDENTIAL_REVIEW_PATHS.approve.replace(":claimId", claimId),
      payload: approveBody(),
    });
    expect(csrfResponse.statusCode).toBe(403);
    expect(csrf.review).not.toHaveBeenCalled();

    for (const payload of [
      { ...approveBody(), actorUserId: adminId },
      { commandId, expectedRevision: 2, reason: "Injected reason." },
      {
        commandId,
        expectedRevision: 2,
        reason: "Missing category must fail closed.",
      },
    ]) {
      const context = fixture();
      const path =
        "reason" in payload && !("actorUserId" in payload)
          ? ADMIN_CREDENTIAL_REVIEW_PATHS.reject
          : ADMIN_CREDENTIAL_REVIEW_PATHS.approve;
      const response = await context.app.inject({
        method: "POST",
        url: path.replace(":claimId", claimId),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(context.review).not.toHaveBeenCalled();
    }
  });

  it("maps credential-review idempotency conflicts to a bounded 409", async () => {
    const context = fixture();
    context.review.mockRejectedValue(new CredentialClaimIdempotencyError());
    const response = await context.app.inject({
      method: "POST",
      url: ADMIN_CREDENTIAL_REVIEW_PATHS.reject.replace(":claimId", claimId),
      payload: reasonBody("Evidence cannot be independently verified."),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("delivers only evidence attached to the exact reviewable claim", async () => {
    const context = fixture();
    const response = await context.app.inject({
      method: "GET",
      url: evidencePath(evidenceId),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      "https://private-storage.invalid/credential?signature=opaque",
    );
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(context.handleDownload).toHaveBeenCalledWith({
      actorUserId: adminId,
      mediaAssetId: evidenceId,
    });
    expect(context.findReviewable).toHaveBeenCalledTimes(2);
    expect(context.findReviewable).toHaveBeenCalledWith(claimId);
    expect(context.authorize).toHaveBeenCalledTimes(2);
  });

  it("uses one uniform 404 for missing claims, foreign evidence, and delivery denial", async () => {
    const responses = [];

    const missing = fixture();
    missing.findReviewable.mockResolvedValue(null);
    responses.push(
      await missing.app.inject({
        method: "GET",
        url: evidencePath(evidenceId),
      }),
    );
    expect(missing.handleDownload).not.toHaveBeenCalled();

    const foreign = fixture();
    responses.push(
      await foreign.app.inject({
        method: "GET",
        url: evidencePath(otherEvidenceId),
      }),
    );
    expect(foreign.handleDownload).not.toHaveBeenCalled();

    const denied = fixture();
    denied.handleDownload.mockResolvedValue({
      body: { code: "MEDIA_NOT_FOUND" },
      headers: { "cache-control": "private, no-store" },
      statusCode: 404,
    });
    responses.push(
      await denied.app.inject({ method: "GET", url: evidencePath(evidenceId) }),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "MEDIA_NOT_FOUND" });
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("withholds a signed redirect when authorization is revoked after signing", async () => {
    const context = fixture();
    context.authorize
      .mockResolvedValueOnce({ actor, status: "AUTHORIZED" })
      .mockResolvedValueOnce({ status: "MFA_TOO_OLD" });
    const response = await context.app.inject({
      method: "GET",
      url: evidencePath(evidenceId),
    });

    expect(context.handleDownload).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "MEDIA_NOT_FOUND" });
    expect(response.headers.location).toBeUndefined();
  });

  it("withholds a signed redirect when the claim-evidence relation is revoked after signing", async () => {
    const context = fixture();
    context.findReviewable
      .mockResolvedValueOnce(reviewItem())
      .mockResolvedValueOnce(null);
    const response = await context.app.inject({
      method: "GET",
      url: evidencePath(evidenceId),
    });

    expect(context.handleDownload).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "MEDIA_NOT_FOUND" });
    expect(response.headers.location).toBeUndefined();
  });
});

function approveBody() {
  return { commandId, expectedRevision: 2 };
}

function reasonBody(reason: string) {
  return {
    commandId,
    expectedRevision: 2,
    reason,
    reasonCategory: "INSUFFICIENT_EVIDENCE" as const,
  };
}

function evidencePath(assetId: string): string {
  return ADMIN_CREDENTIAL_REVIEW_PATHS.evidence
    .replace(":claimId", claimId)
    .replace(":mediaAssetId", assetId);
}

function reviewItem() {
  return {
    claimId,
    createdAt: new Date("2026-09-27T10:00:00.000Z"),
    credentialTypeCode: "test.trade-license",
    email: "must-not-leak@example.invalid",
    evidence: [
      {
        assetId: evidenceId,
        attachedAt: new Date("2026-09-27T10:02:00.000Z"),
        mediaKind: "DOCUMENT" as const,
      },
    ],
    evidenceRequirement: "REQUIRED" as const,
    expiresOn: "2027-09-27",
    ownerUserId: "must-not-leak",
    profession: {
      code: "PROF:CARPENTER",
      id: professionId,
      label: "Stolár",
    },
    profile: {
      id: profileId,
      primaryName: "Majster Ján",
      profileType: "INDIVIDUAL" as const,
      secondaryName: "Ján Remeselný",
    },
    reviewReason: "must-not-leak",
    revision: 2,
    state: "PENDING" as const,
    updatedAt: new Date("2026-09-27T10:02:00.000Z"),
  };
}

function serializedReviewItem() {
  const item = reviewItem();
  return {
    claimId: item.claimId,
    createdAt: item.createdAt.toISOString(),
    credentialTypeCode: item.credentialTypeCode,
    evidence: item.evidence.map((evidence) => ({
      ...evidence,
      attachedAt: evidence.attachedAt.toISOString(),
    })),
    evidenceRequirement: item.evidenceRequirement,
    expiresOn: item.expiresOn,
    profession: item.profession,
    profile: item.profile,
    revision: item.revision,
    state: item.state,
    updatedAt: item.updatedAt.toISOString(),
  };
}

function reviewResult(state: "APPROVED" | "REJECTED" | "REVOKED") {
  const reason =
    state === "APPROVED"
      ? null
      : state === "REJECTED"
        ? "Evidence does not prove the claimed qualification."
        : "The issuing authority has withdrawn this qualification.";
  return {
    claim: {
      id: claimId,
      reviewReason: reason,
      reviewReasonCategory:
        state === "APPROVED" ? null : "INSUFFICIENT_EVIDENCE",
      reviewedAt: now,
      revision: 3,
      state,
    },
    status: "APPLIED" as const,
  };
}
