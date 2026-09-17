import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import { registerJobOperationRoutes } from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000002";
const updateId = "86200000-0000-4000-8000-000000000003";
const issueId = "86200000-0000-4000-8000-000000000004";
const commandId = "86200000-0000-4000-8000-000000000005";
const at = new Date("2026-09-17T08:00:00.000Z");
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(status: "ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE") {
  const app = Fastify();
  const operations = {
    getProgress: vi.fn(() =>
      Promise.resolve({
        id: updateId,
        jobId,
        authorDisplayName: "Majster",
        body: "Práca pokračuje.",
        createdAt: at,
        acknowledgedAt: null,
        media: [
          {
            mediaAssetId: "86200000-0000-4000-8000-000000000006",
            kind: "PHOTO" as const,
            source: "WINNING_CONVERSATION" as const,
            sourceMessageId: "86200000-0000-4000-8000-000000000007",
            uploadedByUserId: actorUserId,
            authorRole: "PRIMARY_PROVIDER" as const,
            uploadedAt: at,
            capturedAt: null,
            chronologicalAt: at,
            displayFilename: "priebeh.jpg",
            contentType: "image/jpeg",
            downloadPath:
              "/v1/media/86200000-0000-4000-8000-000000000006/download",
          },
        ],
      }),
    ),
    listProgress: vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id: updateId,
            jobId,
            authorDisplayName: "Majster",
            body: "Práca pokračuje.",
            createdAt: at,
            acknowledgedAt: null,
            media: [],
          },
        ],
        canCreate: true,
        nextCursor: null,
      }),
    ),
    createProgress: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        id: updateId,
        createdAt: at,
      }),
    ),
    acknowledgeProgress: vi.fn(() =>
      Promise.resolve({ status: "APPLIED" as const, acknowledgedAt: at }),
    ),
    listIssues: vi.fn(() =>
      Promise.resolve({ items: [], canCreate: true, nextCursor: null }),
    ),
    getIssue: vi.fn(() =>
      Promise.resolve({
        id: issueId,
        jobId,
        authorDisplayName: "Zákazník",
        authorRole: "CUSTOMER" as const,
        kind: "DELAY" as const,
        body: "Dodávka mešká.",
        createdAt: at,
        media: [],
      }),
    ),
    createIssue: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        id: issueId,
        createdAt: at,
      }),
    ),
    listIssueComments: vi.fn(() =>
      Promise.resolve({ items: [], canCreate: true, nextCursor: null }),
    ),
    addIssueComment: vi.fn(() =>
      Promise.resolve({
        status: "APPLIED" as const,
        id: commandId,
        createdAt: at,
      }),
    ),
  };
  registerJobOperationRoutes(app, {
    operations,
    guard: {
      evaluate: () =>
        Promise.resolve(
          status === "ACTIVE"
            ? { status: "ACTIVE", user: { id: actorUserId } }
            : { status: "AUTHENTICATION_REQUIRED" },
        ),
    },
    csrfProtection: (_request, _reply, done) => done(),
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, operations };
}

describe("private Job operational updates", () => {
  it("derives actor, serializes exact bounded progress and uses private headers", async () => {
    const { app, operations } = build();
    const response = await app.inject({
      method: "GET",
      url: `/v1/me/jobs/${jobId}/progress?limit=20`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(operations.listProgress).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      limit: 20,
    });
    expect(response.json()).toEqual({
      items: [
        {
          id: updateId,
          jobId,
          authorDisplayName: "Majster",
          body: "Práca pokračuje.",
          createdAt: at.toISOString(),
          acknowledgedAt: null,
          media: [],
        },
      ],
      canCreate: true,
      nextCursor: null,
    });
  });

  it("denies an anonymous actor before touching private records", async () => {
    const { app, operations } = build("AUTHENTICATION_REQUIRED");
    const response = await app.inject({
      method: "POST",
      url: `/v1/me/jobs/${jobId}/issues`,
      payload: {
        commandId,
        kind: "DELAY",
        body: "Čakáme na dodávku materiálu.",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(operations.createIssue).not.toHaveBeenCalled();
  });

  it("rejects unbounded body, extra fields and corrupt cursor", async () => {
    const { app, operations } = build();
    const path = `/v1/me/jobs/${jobId}/progress`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: path,
          payload: { commandId, body: "A", exactAddress: "private" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: path,
          payload: { commandId, body: "x".repeat(2001) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${path}?beforeAt=${encodeURIComponent(at.toISOString())}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${path}?limit=20&limit=21` }))
        .statusCode,
    ).toBe(400);
    expect(operations.createProgress).not.toHaveBeenCalled();
    expect(operations.listProgress).not.toHaveBeenCalled();
  });

  it("keeps acknowledgment separate from commercial consent", async () => {
    const { app, operations } = build();
    const response = await app.inject({
      method: "POST",
      url: `/v1/me/jobs/${jobId}/progress/${updateId}/acknowledge`,
      payload: { commandId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "APPLIED",
      acknowledgedAt: at.toISOString(),
    });
    expect(operations.acknowledgeProgress).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      updateId,
      commandId,
    });
  });

  it("opens an exact private update or Issue from a notification link", async () => {
    const { app, operations } = build();
    const progress = await app.inject({
      method: "GET",
      url: `/v1/me/jobs/${jobId}/progress/${updateId}`,
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json<{ createdAt: string }>().createdAt).toBe(
      at.toISOString(),
    );
    expect(
      progress.json<{
        media: Array<{ uploadedAt: string; chronologicalAt: string }>;
      }>().media[0],
    ).toMatchObject({
      uploadedAt: at.toISOString(),
      chronologicalAt: at.toISOString(),
    });
    expect(operations.getProgress).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      updateId,
    });
    const issue = await app.inject({
      method: "GET",
      url: `/v1/me/jobs/${jobId}/issues/${issueId}`,
    });
    expect(issue.statusCode).toBe(200);
    expect(issue.json<{ kind: string }>().kind).toBe("DELAY");
    expect(operations.getIssue).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      issueId,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/me/jobs/${jobId}/issues/${issueId}?foo=bar`,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("validates bounded media IDs and forwards an authorized attachment choice", async () => {
    const { app, operations } = build();
    const mediaAssetId = "86200000-0000-4000-8000-000000000006";
    const response = await app.inject({
      method: "POST",
      url: `/v1/me/jobs/${jobId}/progress`,
      payload: {
        commandId,
        body: "Práce pokračujú.",
        mediaAssetIds: [mediaAssetId],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(operations.createProgress).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      commandId,
      body: "Práce pokračujú.",
      mediaAssetIds: [mediaAssetId],
    });
    for (const mediaAssetIds of [
      [mediaAssetId, mediaAssetId],
      Array.from(
        { length: 6 },
        (_, i) => `86200000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
      ),
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/me/jobs/${jobId}/issues`,
            payload: {
              commandId,
              kind: "PROBLEM",
              body: "Treba opraviť detail.",
              mediaAssetIds,
            },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(operations.createIssue).not.toHaveBeenCalled();
  });
});
