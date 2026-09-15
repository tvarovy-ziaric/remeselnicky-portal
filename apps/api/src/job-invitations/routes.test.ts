import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  JobInvitationIdempotencyError,
  type CraftsmanProfileId,
  type JobInvitationId,
  type JobRequestId,
  type UserId,
} from "@portal/domain";

import {
  JOB_INVITATION_PATH,
  JOB_INVITATION_PATHS,
  registerJobInvitationRoutes,
} from "./routes.js";

const actor = "9d100000-0000-4000-8000-000000000001" as UserId;
const requestId = "9d100000-0000-4000-8000-000000000002" as JobRequestId;
const profileId = "9d100000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const commandId = "9d100000-0000-4000-8000-000000000004";
const invitationId = "9d100000-0000-4000-8000-000000000005" as JobInvitationId;
const now = new Date("2026-09-15T08:00:00Z");

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

  it("lists and reads only the explicit pre-confirmation projection", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobInvitationRoutes(app, fixture.dependencies);
    const listResponse = await app.inject({
      method: "GET",
      url: `${JOB_INVITATION_PATHS.list}?limit=25`,
    });
    expect(listResponse.statusCode).toBe(200);
    expect(fixture.listOwned).toHaveBeenCalledWith({
      actorUserId: actor,
      limit: 25,
    });
    expect(listResponse.json()).toEqual({
      items: [
        {
          changedAt: "2026-09-15T08:00:00.000Z",
          counterpartDisplayName: "Majster Test",
          expiresAt: "2026-09-22T08:00:00.000Z",
          id: invitationId,
          jobRequestId: requestId,
          perspective: "CUSTOMER",
          requestTitle: "Oprava strechy",
          revision: 1,
          state: "PENDING",
        },
      ],
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: JOB_INVITATION_PATHS.detail.replace(":invitationId", invitationId),
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.headers["cache-control"]).toBe("no-store");
    expect(fixture.readOwned).toHaveBeenCalledWith({
      actorUserId: actor,
      invitationId,
    });
    const body = detailResponse.body;
    expect(body).not.toContain("exactAddress");
    expect(body).not.toContain("mapPin");
    expect(body).not.toContain("contact");
    expect(detailResponse.json()).toMatchObject({
      competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS",
      request: {
        description: "Výmena krytiny na prístrešku",
        municipalityCode: "MUN:TEST",
        primaryProfessionCode: "PROF:ROOFER",
      },
      requestContentRevision: 2,
      requestVisibleVersion: 1,
    });
    await app.close();
  });

  it("applies craftsman and customer actions with CSRF and revision CAS", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobInvitationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: { action: "ENGAGE", commandId, expectedRevision: 1 },
      url: JOB_INVITATION_PATHS.respond.replace(":invitationId", invitationId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      revision: 2,
      state: "ENGAGED",
      status: "APPLIED",
    });
    expect(fixture.respondOwned).toHaveBeenCalledWith({
      action: "ENGAGE",
      actorUserId: actor,
      commandId,
      expectedRevision: 1,
      invitationId,
    });
    expect(fixture.csrf).toHaveBeenCalledOnce();

    fixture.closeOwned.mockResolvedValueOnce({
      currentRevision: 3,
      status: "STALE_REVISION",
    });
    const closeResponse = await app.inject({
      method: "POST",
      payload: { action: "STOP_CONSIDERING", commandId, expectedRevision: 2 },
      url: JOB_INVITATION_PATHS.close.replace(":invitationId", invitationId),
    });
    expect(closeResponse.statusCode).toBe(409);
    expect(closeResponse.json()).toEqual({
      code: "STALE_REVISION",
      currentRevision: 3,
    });
    await app.close();
  });

  it("uses a uniform 404 for unavailable invitation details", async () => {
    const fixture = createFixture();
    fixture.readOwned.mockResolvedValueOnce(null);
    const app = Fastify();
    registerJobInvitationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: JOB_INVITATION_PATHS.detail.replace(":invitationId", invitationId),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "NOT_FOUND" });
    expect(response.body).not.toContain("profile");
    await app.close();
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
  const listItem = {
    changedAt: now,
    counterpartDisplayName: "Majster Test",
    expiresAt: new Date("2026-09-22T08:00:00Z"),
    id: invitationId,
    jobRequestId: requestId,
    perspective: "CUSTOMER" as const,
    requestTitle: "Oprava strechy",
    revision: 1,
    state: "PENDING" as const,
  };
  const listOwned = vi.fn().mockResolvedValue([listItem]);
  const readOwned = vi.fn().mockResolvedValue({
    ...listItem,
    competitionDisclosure: "CUSTOMER_MAY_CONTACT_OTHERS" as const,
    customerTrust: {
      permittedReviewComments: [],
      rating: null,
      reviewCount: 0,
    },
    request: {
      approximateDistanceKm: 12,
      budget: {
        currency: "EUR" as const,
        maximumAmountCents: 200_000,
        minimumAmountCents: 100_000,
        mode: "RANGE" as const,
      },
      description: "Výmena krytiny na prístrešku",
      details: {
        approximateQuantity: "20 m2",
        customRequirements: null,
        materialResponsibility: "COMBINATION" as const,
        siteInspection: "MAYBE" as const,
      },
      documentMediaAssetIds: [],
      municipalityCode: "MUN:TEST",
      photoMediaAssetIds: [],
      primaryProfessionCode: "PROF:ROOFER",
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      timing: {
        completionDeadline: null,
        endsOn: null,
        mode: "FLEXIBLE" as const,
        startsOn: null,
      },
      title: "Oprava strechy",
    },
    requestContentRevision: 2,
    requestVisibleVersion: 1,
  });
  const respondOwned = vi.fn().mockResolvedValue({
    invitation: {
      changedAt: now,
      craftsmanProfileId: profileId,
      customerProfileId: "9d100000-0000-4000-8000-000000000006",
      declineNote: null,
      declineReason: null,
      engagedAt: now,
      expiresAt: new Date("2026-09-22T08:00:00Z"),
      id: invitationId,
      jobRequestId: requestId,
      requestContentRevision: 2,
      requestVisibleVersion: 1,
      revision: 2,
      sentAt: now,
      state: "ENGAGED",
    },
    status: "APPLIED",
  });
  const closeOwned = vi.fn().mockResolvedValue({
    invitation: {
      changedAt: now,
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
      revision: 2,
      sentAt: now,
      state: "WITHDRAWN",
    },
    status: "APPLIED",
  });
  return {
    closeOwned,
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
      invitations: {
        closeOwned,
        listOwned,
        readOwned,
        respondOwned,
        sendOwned,
      },
      rateLimit: { max: 50, timeWindowMs: 60_000 },
    },
    listOwned,
    readOwned,
    respondOwned,
    sendOwned,
  };
}

function path(): string {
  return JOB_INVITATION_PATH.replace(":jobRequestId", requestId);
}
