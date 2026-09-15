import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  ConversationId,
  JobInvitationId,
  JobRequestId,
  UserId,
} from "@portal/domain";

import { CONVERSATION_PATHS, registerConversationRoutes } from "./routes.js";

const actorUserId = "9e200000-0000-4000-8000-000000000001" as UserId;
const conversationId = "9e200000-0000-4000-8000-000000000002" as ConversationId;
const invitationId = "9e200000-0000-4000-8000-000000000003" as JobInvitationId;
const jobRequestId = "9e200000-0000-4000-8000-000000000004" as JobRequestId;

describe("conversation routes", () => {
  it("returns only the participant-facing conversation identity", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: CONVERSATION_PATHS.byId.replace(":conversationId", conversationId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      access: "WRITABLE",
      counterpartDisplayName: "Majster Test",
      createdAt: "2026-09-15T08:00:00.000Z",
      id: conversationId,
      invitationId,
      jobRequestId,
      participantRole: "CUSTOMER",
      requestTitle: "Oprava strechy",
    });
    expect(response.body).not.toMatch(/customerProfileId|craftsmanProfileId/);
    expect(fixture.readOwned).toHaveBeenCalledWith({
      actorUserId,
      conversationId,
    });
    await app.close();
  });

  it("resolves the same conversation from its exact invitation", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: CONVERSATION_PATHS.byInvitation.replace(
        ":invitationId",
        invitationId,
      ),
    });
    expect(response.statusCode).toBe(200);
    expect(fixture.readOwnedByInvitation).toHaveBeenCalledWith({
      actorUserId,
      invitationId,
    });
    await app.close();
  });

  it("uses a uniform 404 for non-participants and pre-engagement", async () => {
    const fixture = createFixture();
    fixture.readOwned.mockResolvedValueOnce(null);
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: CONVERSATION_PATHS.byId.replace(":conversationId", conversationId),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "NOT_FOUND" });
    expect(response.body).not.toMatch(/participant|invitation|profile/);
    await app.close();
  });

  it("denies unauthenticated and inactive actors before persistence", async () => {
    for (const status of [
      "AUTHENTICATION_REQUIRED",
      "ACCOUNT_NOT_ACTIVE",
    ] as const) {
      const fixture = createFixture(status);
      const app = Fastify();
      registerConversationRoutes(app, fixture.dependencies);
      const response = await app.inject({
        method: "GET",
        url: CONVERSATION_PATHS.byId.replace(":conversationId", conversationId),
      });
      expect(response.statusCode).toBe(
        status === "AUTHENTICATION_REQUIRED" ? 401 : 403,
      );
      expect(fixture.readOwned).not.toHaveBeenCalled();
      await app.close();
    }
  });
});

function createFixture(
  guardStatus:
    "ACCOUNT_NOT_ACTIVE" | "ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE",
) {
  const conversation = Object.freeze({
    access: "WRITABLE" as const,
    counterpartDisplayName: "Majster Test",
    craftsmanProfileId: "9e200000-0000-4000-8000-000000000005" as never,
    createdAt: new Date("2026-09-15T08:00:00Z"),
    customerProfileId: "9e200000-0000-4000-8000-000000000006" as never,
    id: conversationId,
    invitationId,
    jobRequestId,
    participantRole: "CUSTOMER" as const,
    requestTitle: "Oprava strechy",
  });
  const readOwned = vi.fn().mockResolvedValue(conversation);
  const readOwnedByInvitation = vi.fn().mockResolvedValue(conversation);
  return {
    dependencies: {
      conversations: { readOwned, readOwnedByInvitation },
      guard: {
        evaluate: vi
          .fn()
          .mockResolvedValue(
            guardStatus === "ACTIVE"
              ? { status: "ACTIVE", user: { id: actorUserId } }
              : { status: guardStatus },
          ),
      },
    },
    readOwned,
    readOwnedByInvitation,
  };
}
