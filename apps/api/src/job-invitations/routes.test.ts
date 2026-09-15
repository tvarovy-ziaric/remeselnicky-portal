import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  JobInvitationIdempotencyError,
  type CraftsmanProfileId,
  type JobInvitationId,
  type JobRequestId,
  type UserId,
} from "@portal/domain";

import { JOB_INVITATION_PATH, registerJobInvitationRoutes } from "./routes.js";

const actor = "9d100000-0000-4000-8000-000000000001" as UserId;
const requestId = "9d100000-0000-4000-8000-000000000002" as JobRequestId;
const profileId = "9d100000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const commandId = "9d100000-0000-4000-8000-000000000004";
const invitationId = "9d100000-0000-4000-8000-000000000005" as JobInvitationId;

describe("job invitation routes", () => {
  it("sends one selected candidate through the authoritative command", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobInvitationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: { commandId, craftsmanProfileId: profileId },
      url: path(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      id: invitationId,
      revision: 1,
      state: "PENDING",
      status: "APPLIED",
    });
    expect(fixture.csrf).toHaveBeenCalledOnce();
    expect(fixture.sendOwned).toHaveBeenCalledWith({
      actorUserId: actor,
      commandId,
      craftsmanProfileId: profileId,
      jobRequestId: requestId,
    });
    await app.close();
  });

  it("maps eligibility and the active-five limit without leaking a target", async () => {
    const limited = createFixture();
    limited.sendOwned.mockResolvedValueOnce({
      activeLimit: 5,
      status: "ACTIVE_LIMIT_REACHED",
    });
    const limitedApp = Fastify();
    registerJobInvitationRoutes(limitedApp, limited.dependencies);
    const limitResponse = await limitedApp.inject({
      method: "POST",
      payload: { commandId, craftsmanProfileId: profileId },
      url: path(),
    });
    expect(limitResponse.statusCode).toBe(409);
    expect(limitResponse.json()).toEqual({
      activeLimit: 5,
      code: "ACTIVE_LIMIT_REACHED",
    });
    await limitedApp.close();

    const unavailable = createFixture();
    unavailable.sendOwned.mockResolvedValueOnce({
      status: "TARGET_NOT_ELIGIBLE",
    });
    const unavailableApp = Fastify();
    registerJobInvitationRoutes(unavailableApp, unavailable.dependencies);
    const unavailableResponse = await unavailableApp.inject({
      method: "POST",
      payload: { commandId, craftsmanProfileId: profileId },
      url: path(),
    });
    expect(unavailableResponse.statusCode).toBe(404);
    expect(unavailableResponse.json()).toEqual({ code: "NOT_FOUND" });
    await unavailableApp.close();
  });

  it("denies unauthenticated selection before the invitation service", async () => {
    const fixture = createFixture("AUTHENTICATION_REQUIRED");
    const app = Fastify();
    registerJobInvitationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: { commandId, craftsmanProfileId: profileId },
      url: path(),
    });
    expect(response.statusCode).toBe(401);
    expect(fixture.sendOwned).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects malformed bodies and command-id collisions", async () => {
    const malformed = createFixture();
    const malformedApp = Fastify();
    registerJobInvitationRoutes(malformedApp, malformed.dependencies);
    const malformedResponse = await malformedApp.inject({
      method: "POST",
      payload: { commandId: "not-a-uuid", craftsmanProfileId: profileId },
      url: path(),
    });
    expect(malformedResponse.statusCode).toBe(400);
    expect(malformed.sendOwned).not.toHaveBeenCalled();
    await malformedApp.close();

    const collision = createFixture();
    collision.sendOwned.mockRejectedValueOnce(
      new JobInvitationIdempotencyError(),
    );
    const collisionApp = Fastify();
    registerJobInvitationRoutes(collisionApp, collision.dependencies);
    const collisionResponse = await collisionApp.inject({
      method: "POST",
      payload: { commandId, craftsmanProfileId: profileId },
      url: path(),
    });
    expect(collisionResponse.statusCode).toBe(409);
    expect(collisionResponse.json()).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    await collisionApp.close();
  });
});

function createFixture(
  status: "ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE",
) {
  const csrf = vi.fn((_request: unknown, _reply: unknown, done: () => void) =>
    done(),
  );
  const sendOwned = vi.fn().mockResolvedValue({
    invitation: {
      changedAt: new Date("2026-09-15T08:00:00Z"),
      craftsmanProfileId: profileId,
      customerProfileId: "9d100000-0000-4000-8000-000000000006",
      declineNote: null,
      declineReason: null,
      engagedAt: null,
      expiresAt: new Date("2026-09-22T08:00:00Z"),
      id: invitationId,
      jobRequestId: requestId,
      requestContentRevision: 2,
      requestVisibleVersion: 1,
      revision: 1,
      sentAt: new Date("2026-09-15T08:00:00Z"),
      state: "PENDING",
    },
    status: "APPLIED",
  });
  return {
    csrf,
    dependencies: {
      csrfProtection: csrf,
      guard: {
        evaluate: () =>
          Promise.resolve(
            status === "ACTIVE"
              ? { status: "ACTIVE" as const, user: { id: actor } }
              : { status: "AUTHENTICATION_REQUIRED" as const },
          ),
      },
      invitations: { sendOwned },
      rateLimit: { max: 50, timeWindowMs: 60_000 },
    },
    sendOwned,
  };
}

function path(): string {
  return JOB_INVITATION_PATH.replace(":jobRequestId", requestId);
}
