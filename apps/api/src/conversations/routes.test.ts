import Fastify from "fastify";
import type { onRequestHookHandler } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  ConversationId,
  ConversationMessageId,
  JobInvitationId,
  JobRequestId,
  UserId,
} from "@portal/domain";

import { CONVERSATION_PATHS, registerConversationRoutes } from "./routes.js";

const actorUserId = "9e200000-0000-4000-8000-000000000001" as UserId;
const conversationId = "9e200000-0000-4000-8000-000000000002" as ConversationId;
const invitationId = "9e200000-0000-4000-8000-000000000003" as JobInvitationId;
const jobRequestId = "9e200000-0000-4000-8000-000000000004" as JobRequestId;
const messageId =
  "9e200000-0000-4000-8000-000000000007" as ConversationMessageId;
const commandId = "9e200000-0000-4000-8000-000000000008";
const mediaAssetId = "9e200000-0000-4000-8000-000000000010";

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
    expect(fixture.evaluate).toHaveBeenCalledWith(expect.anything(), undefined);
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

  it("returns an exact allowlisted private timeline with read state", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: `${CONVERSATION_PATHS.timeline.replace(":conversationId", conversationId)}?limit=20`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      entries: [
        {
          attachments: [
            {
              assetId: mediaAssetId,
              createdAt: "2026-09-15T08:01:01.000Z",
              kind: "IMAGE",
              status: "PROCESSING",
            },
          ],
          author: "COUNTERPART",
          authorRole: "CRAFTSMAN",
          body: "Dobrý deň",
          createdAt: "2026-09-15T08:01:00.000Z",
          id: messageId,
          kind: "HUMAN_MESSAGE",
          hiddenByModeration: false,
          readByCounterpart: null,
          replyToMessageId: null,
          sequence: 2,
          systemEvent: null,
        },
      ],
      hasMore: false,
      nextBeforeSequence: null,
      participantState: {
        archived: false,
        lastReadAt: null,
        lastReadSequence: 0,
        muted: false,
        revision: 0,
      },
      unreadCount: 1,
    });
    expect(response.body).not.toMatch(/email|phone|storage|profileId/iu);
    await app.close();
  });

  it("uploads only allowlisted private IMAGE/PDF bytes to an exact source message", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const url = CONVERSATION_PATHS.attachments
      .replace(":conversationId", conversationId)
      .replace(":messageId", messageId)
      .replace(":mediaKind", "photos");
    const response = await app.inject({
      headers: { "content-type": "image/jpeg" },
      method: "POST",
      payload: Buffer.from([0xff, 0xd8, 0xff]),
      url,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      assetId: mediaAssetId,
      kind: "IMAGE",
      status: "PROCESSING",
    });
    expect(fixture.uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        declaredContentType: "image/jpeg",
        mediaKind: "IMAGE",
        messageId,
      }),
    );
    expect(fixture.evaluate).toHaveBeenCalledWith(
      expect.anything(),
      "MESSAGING",
    );
    expect(response.body).not.toMatch(/storage|url|filename/iu);

    const invalid = await app.inject({
      headers: { "content-type": "application/pdf" },
      method: "POST",
      payload: Buffer.from("%PDF-1.7\n%%EOF"),
      url,
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.uploadAttachment).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("delivers READY private media only through the no-store redirect seam", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: CONVERSATION_PATHS.mediaDownload.replace(
        ":mediaAssetId",
        mediaAssetId,
      ),
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers.location).toBe("https://private.invalid/grant");
    expect(response.body).toBe("");
    expect(fixture.recordSuccessfulDelivery).toHaveBeenCalledWith({
      actorUserId,
      mediaAssetId,
    });
    await app.close();
  });

  it("fails closed before write services when layered admission is absent or exhausted", async () => {
    const fixture = createFixture();
    const { admission: _admission, ...chatWithoutAdmission } =
      fixture.dependencies.chat;
    expect(_admission).toBeDefined();
    const unavailableApp = Fastify();
    registerConversationRoutes(unavailableApp, {
      ...fixture.dependencies,
      chat: chatWithoutAdmission,
    });
    const url = CONVERSATION_PATHS.messages.replace(
      ":conversationId",
      conversationId,
    );
    const unavailable = await unavailableApp.inject({
      method: "POST",
      payload: { body: "Dobrý deň", commandId },
      url,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    await unavailableApp.close();

    const limited = createFixture();
    limited.admit.mockResolvedValueOnce("RATE_LIMITED");
    const limitedApp = Fastify();
    registerConversationRoutes(limitedApp, limited.dependencies);
    const denied = await limitedApp.inject({
      method: "POST",
      payload: { body: "Dobrý deň", commandId },
      url,
    });
    expect(denied.statusCode).toBe(429);
    expect(limited.sendMessage).not.toHaveBeenCalled();
    await limitedApp.close();
  });

  it("protects message sends with CSRF and maps policy/read-only outcomes", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const url = CONVERSATION_PATHS.messages.replace(
      ":conversationId",
      conversationId,
    );
    const sent = await app.inject({
      method: "POST",
      payload: { body: "Dobrý deň", commandId },
      url,
    });
    expect(sent.statusCode).toBe(201);
    expect(fixture.csrfCalls()).toBe(1);
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      actorUserId,
      body: "Dobrý deň",
      commandId,
      conversationId,
      replyToMessageId: null,
    });

    fixture.sendMessage.mockResolvedValueOnce({
      status: "BLOCKED_BY_CONTACT_POLICY",
    });
    const blocked = await app.inject({
      method: "POST",
      payload: { body: "kontakt@example.sk", commandId },
      url,
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toEqual({ code: "CONTACT_SHARING_NOT_AVAILABLE" });
    expect(blocked.body).not.toContain("kontakt@example.sk");
    expect(Object.keys(blocked.json())).toEqual(["code"]);

    fixture.sendMessage.mockResolvedValueOnce({ status: "READ_ONLY" });
    const readOnly = await app.inject({
      method: "POST",
      payload: { body: "neskoro", commandId },
      url,
    });
    expect(readOnly.statusCode).toBe(409);
    expect(readOnly.json()).toEqual({ code: "CONVERSATION_READ_ONLY" });
    await app.close();
  });

  it("updates local state and creates privacy-minimal reports", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerConversationRoutes(app, fixture.dependencies);
    const state = await app.inject({
      method: "POST",
      payload: {
        action: "MARK_READ",
        commandId,
        expectedRevision: 0,
        readThroughSequence: 2,
      },
      url: CONVERSATION_PATHS.state.replace(":conversationId", conversationId),
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      participantState: { lastReadSequence: 2, revision: 1 },
      status: "APPLIED",
    });

    const report = await app.inject({
      method: "POST",
      payload: { commandId, messageId, reason: "ABUSE" },
      url: CONVERSATION_PATHS.report.replace(":conversationId", conversationId),
    });
    expect(report.statusCode).toBe(201);
    expect(report.json()).toEqual({ status: "REPORTED" });
    expect(fixture.report).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      conversationId,
      messageId,
      reason: "ABUSE",
    });
    await app.close();
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
  const entry = Object.freeze({
    attachments: Object.freeze([
      Object.freeze({
        assetId: mediaAssetId,
        createdAt: new Date("2026-09-15T08:01:01Z"),
        kind: "IMAGE" as const,
        status: "PROCESSING" as const,
      }),
    ]),
    author: "COUNTERPART" as const,
    authorRole: "CRAFTSMAN" as const,
    body: "Dobrý deň",
    conversationId,
    createdAt: new Date("2026-09-15T08:01:00Z"),
    id: messageId,
    kind: "HUMAN_MESSAGE" as const,
    hiddenByModeration: false,
    readByCounterpart: null,
    replyToMessageId: null,
    sequence: 2,
    systemEvent: null,
  });
  const readTimeline = vi.fn().mockResolvedValue({
    entries: [entry],
    hasMore: false,
    nextBeforeSequence: null,
    participantState: {
      archived: false,
      lastReadAt: null,
      lastReadSequence: 0,
      muted: false,
      revision: 0,
    },
    unreadCount: 1,
  });
  const sendMessage = vi.fn().mockResolvedValue({ entry, status: "SENT" });
  const updateParticipantState = vi.fn().mockResolvedValue({
    participantState: {
      archived: false,
      lastReadAt: new Date("2026-09-15T08:02:00Z"),
      lastReadSequence: 2,
      muted: false,
      revision: 1,
    },
    status: "APPLIED",
  });
  const report = vi.fn().mockResolvedValue({
    reportId: "9e200000-0000-4000-8000-000000000009",
    status: "REPORTED",
  });
  const admit = vi.fn().mockResolvedValue("ADMITTED" as const);
  const uploadAttachment = vi.fn().mockResolvedValue({
    assetId: mediaAssetId,
    kind: "IMAGE",
    status: "PROCESSING",
  });
  const handleDownload = vi.fn().mockResolvedValue({
    headers: {
      "cache-control": "private, no-store",
      location: "https://private.invalid/grant",
      "referrer-policy": "no-referrer",
    },
    statusCode: 303,
  });
  const recordSuccessfulDelivery = vi.fn().mockResolvedValue(undefined);
  let csrfCallCount = 0;
  const csrfProtection: onRequestHookHandler = (_request, _reply, done) => {
    csrfCallCount += 1;
    done();
  };
  const evaluate = vi
    .fn()
    .mockResolvedValue(
      guardStatus === "ACTIVE"
        ? { status: "ACTIVE", user: { id: actorUserId } }
        : { status: guardStatus },
    );
  return {
    dependencies: {
      chat: {
        admission: { admit },
        attachmentUploads: { upload: uploadAttachment },
        csrfProtection,
        persistence: { readTimeline },
        pdfDeliveryObservation: { recordSuccessfulDelivery },
        privateMediaDelivery: { handleDownload },
        service: { report, sendMessage, updateParticipantState },
      },
      conversations: { readOwned, readOwnedByInvitation },
      guard: { evaluate },
    },
    csrfCalls: () => csrfCallCount,
    admit,
    evaluate,
    readOwned,
    readOwnedByInvitation,
    readTimeline,
    recordSuccessfulDelivery,
    report,
    sendMessage,
    uploadAttachment,
    updateParticipantState,
  };
}
