import { createHash } from "node:crypto";

import type { PrivilegedActor } from "@portal/admin-auth";
import { CraftsmanPublicationIdempotencyError } from "@portal/db";
import type { UserId } from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PROFILE_REVIEW_PATHS,
  registerAdminProfileReviewRoutes,
} from "./routes.js";

const adminId = "b2000000-0000-4000-8000-000000000001" as UserId;
const otherId = "b2000000-0000-4000-8000-000000000002" as UserId;
const profileId = "b2000000-0000-4000-8000-000000000003";
const commandId = "b2000000-0000-4000-8000-000000000004";
const correlationId = "b2000000-0000-4000-8000-000000000005";
const sessionId = "opaque-profile-review-session";
const now = new Date("2026-09-28T12:00:00.000Z");
const actor: PrivilegedActor = {
  capabilities: new Set(["admin.profiles.review"]),
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
    items: [review()],
    nextCursor: null,
  });
  const findPending = vi.fn().mockResolvedValue(review());
  const approve = vi.fn().mockResolvedValue(commandResult("APPROVED"));
  const reject = vi.fn().mockResolvedValue(commandResult("REJECTED"));
  registerAdminProfileReviewRoutes(app, {
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
            : input?.identity === "INACTIVE"
              ? { status: "ACCOUNT_NOT_ACTIVE" }
              : { status: "ACTIVE", user: { id: adminId } },
        ),
    },
    publications: { approve, reject },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
    reviews: { findPending, listPending },
  });
  return { app, approve, authorize, findPending, listPending, reject };
}

describe("administrative craftsman profile review routes", () => {
  it("lists only the privacy-minimal bounded PENDING projection with recent MFA", async () => {
    const { app, authorize, listPending } = fixture();
    const response = await app.inject({
      method: "GET",
      url: `${ADMIN_PROFILE_REVIEW_PATHS.queue}?limit=20`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(authorize).toHaveBeenCalledWith({
      capability: "admin.profiles.review",
      requireRecentMfa: true,
      sessionId,
      userId: adminId,
    });
    expect(listPending).toHaveBeenCalledWith({ limit: 20 });
    expect(response.json()).toEqual({
      items: [{ ...serializedReview() }],
      nextCursor: null,
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /email|phone|verificationReference|session|mfa|audit|ownerUserId/iu,
    );
  });

  it("loads an exact pending detail without broadening its field set", async () => {
    const { app, findPending } = fixture();
    const response = await app.inject({
      method: "GET",
      url: ADMIN_PROFILE_REVIEW_PATHS.detail.replace(":profileId", profileId),
    });
    expect(response.statusCode).toBe(200);
    expect(findPending).toHaveBeenCalledWith(profileId);
    expect(response.json()).toEqual(serializedReview());
  });

  it("approves through the existing publication command using only a session digest", async () => {
    const { app, approve } = fixture();
    const response = await app.inject({
      method: "POST",
      url: ADMIN_PROFILE_REVIEW_PATHS.approve.replace(":profileId", profileId),
      payload: {
        commandId,
        correlationId,
        expectedRevision: 2,
        reason: "Profile meets the publication minimum.",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(approve).toHaveBeenCalledWith({
      actorSessionIdDigest: createHash("sha256")
        .update(sessionId, "utf8")
        .digest("hex"),
      actorUserId: adminId,
      commandId,
      correlationId,
      craftsmanProfileId: profileId,
      expectedRevision: 2,
      reason: "Profile meets the publication minimum.",
    });
    expect(JSON.stringify(approve.mock.calls[0])).not.toContain(sessionId);
    expect(response.json()).toEqual({
      publication: { profileId, revision: 3, reviewState: "APPROVED" },
      status: "APPLIED",
    });
  });

  it("rejects with separate internal provenance and user-facing reason", async () => {
    const { app, reject } = fixture();
    const response = await app.inject({
      method: "POST",
      url: ADMIN_PROFILE_REVIEW_PATHS.reject.replace(":profileId", profileId),
      payload: {
        commandId,
        correlationId,
        expectedRevision: 2,
        reason: "Identity presentation is incomplete.",
        reasonCode: "IDENTITY_INCOMPLETE",
        userFacingReason: "Doplňte celé meno uvedené v profile.",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: adminId,
        reasonCode: "IDENTITY_INCOMPLETE",
        userFacingReason: "Doplňte celé meno uvedené v profile.",
      }),
    );
  });

  it("fails closed for anonymous, inactive, old-MFA, ordinary and mismatched actors", async () => {
    for (const identity of ["ANONYMOUS", "INACTIVE"] as const) {
      const context = fixture({ identity });
      const response = await context.app.inject({
        method: "GET",
        url: ADMIN_PROFILE_REVIEW_PATHS.queue,
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
        url: ADMIN_PROFILE_REVIEW_PATHS.queue,
      });
      expect(response.statusCode).toBe(403);
      expect(context.listPending).not.toHaveBeenCalled();
    }
  });

  it("rejects CSRF failures and malformed or expanded command bodies", async () => {
    const csrf = fixture({ csrf: false });
    expect(
      (
        await csrf.app.inject({
          method: "POST",
          url: ADMIN_PROFILE_REVIEW_PATHS.approve.replace(
            ":profileId",
            profileId,
          ),
          payload: approveBody(),
        })
      ).statusCode,
    ).toBe(403);
    expect(csrf.approve).not.toHaveBeenCalled();

    const malformed = fixture();
    const response = await malformed.app.inject({
      method: "POST",
      url: ADMIN_PROFILE_REVIEW_PATHS.approve.replace(":profileId", profileId),
      payload: { ...approveBody(), actorUserId: adminId },
    });
    expect(response.statusCode).toBe(400);
    expect(malformed.approve).not.toHaveBeenCalled();
  });

  it("maps stale, invalid-transition and idempotency outcomes without leaking input", async () => {
    const stale = fixture();
    stale.approve.mockResolvedValue({ status: "STALE_REVISION" });
    expect(
      (
        await stale.app.inject({
          method: "POST",
          url: ADMIN_PROFILE_REVIEW_PATHS.approve.replace(
            ":profileId",
            profileId,
          ),
          payload: approveBody(),
        })
      ).json(),
    ).toEqual({ code: "STALE_REVISION" });

    const invalid = fixture();
    invalid.approve.mockResolvedValue({ status: "INVALID_TRANSITION" });
    expect(
      (
        await invalid.app.inject({
          method: "POST",
          url: ADMIN_PROFILE_REVIEW_PATHS.approve.replace(
            ":profileId",
            profileId,
          ),
          payload: approveBody(),
        })
      ).statusCode,
    ).toBe(409);

    const conflict = fixture();
    conflict.approve.mockRejectedValue(
      new CraftsmanPublicationIdempotencyError(),
    );
    const response = await conflict.app.inject({
      method: "POST",
      url: ADMIN_PROFILE_REVIEW_PATHS.approve.replace(":profileId", profileId),
      payload: approveBody(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

function approveBody() {
  return {
    commandId,
    correlationId,
    expectedRevision: 2,
    reason: "Profile meets the publication minimum.",
  };
}

function review() {
  return {
    about: "Poctivá stolárska výroba.",
    baseMunicipality: { code: "SK0101528595", name: "Bratislava" },
    identity: {
      primaryName: "Majster Jano",
      profileType: "INDIVIDUAL" as const,
      secondaryName: "Ján Remeselný",
    },
    normalRadiusMeters: 25_000,
    professions: [
      {
        code: "PROF:CARPENTER",
        declaredLevel: "MASTER" as const,
        label: "Stolár",
      },
    ],
    profileId,
    publicationRevision: 2,
    readiness: { isReady: true, missing: [] },
    submittedAt: now,
  };
}

function serializedReview() {
  return { ...review(), submittedAt: now.toISOString() };
}

function commandResult(reviewState: "APPROVED" | "REJECTED") {
  return {
    publication: {
      approved:
        reviewState === "APPROVED"
          ? { actorUserId: adminId, occurredAt: now }
          : null,
      changedAt: now,
      craftsmanProfileId: profileId,
      effectivelyPublic: reviewState === "APPROVED",
      moderation: null,
      moderationState: "ALLOWED" as const,
      ownerVisibility: "PUBLIC" as const,
      readiness: { isReady: true, missing: [] },
      rejection:
        reviewState === "REJECTED"
          ? {
              actorUserId: adminId,
              occurredAt: now,
              reasonCode: "IDENTITY_INCOMPLETE",
              userFacingReason: "Doplňte celé meno uvedené v profile.",
            }
          : null,
      reviewState,
      revision: 3,
    },
    status: "APPLIED" as const,
  };
}
