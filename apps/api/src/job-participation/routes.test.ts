import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import {
  JOB_PARTICIPATION_PATHS,
  registerJobParticipationRoutes,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const jobId = "86200000-0000-4000-8000-000000000002";
const participantId = "86200000-0000-4000-8000-000000000003";
const craftsmanProfileId = "86200000-0000-4000-8000-000000000004";
const commandId = "86200000-0000-4000-8000-000000000005";
const invitedAt = new Date("2026-09-16T18:00:00.000Z");
const inviteUrl = JOB_PARTICIPATION_PATHS.invite.replace(":jobId", jobId);
const decisionUrl = JOB_PARTICIPATION_PATHS.decide.replace(
  ":participantId",
  participantId,
);
const roleUrl = JOB_PARTICIPATION_PATHS.role.replace(
  ":participantId",
  participantId,
);
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  list?: ReturnType<typeof vi.fn>;
  listOwnHistory?: ReturnType<typeof vi.fn>;
  invite?: ReturnType<typeof vi.fn>;
  decide?: ReturnType<typeof vi.fn>;
  changeRole?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const list =
    input?.list ??
    vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
  const listOwnHistory =
    input?.listOwnHistory ??
    vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
  const invite =
    input?.invite ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  const decide =
    input?.decide ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  const changeRole =
    input?.changeRole ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  registerJobParticipationRoutes(app, {
    participation: {
      listPendingForInvitee: list,
      listOwnHistory,
      invite,
      decide,
      changeRole,
    },
    csrfProtection: (_request, _reply, done) => done(),
    guard: {
      evaluate: () =>
        Promise.resolve(
          input?.status === "ACCOUNT_NOT_ACTIVE" ||
            input?.status === "AUTHENTICATION_REQUIRED"
            ? { status: input.status }
            : { status: "ACTIVE", user: { id: actorUserId } },
        ),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  apps.push(app);
  return { app, list, listOwnHistory, invite, decide, changeRole };
}

describe("private Job participation routes", () => {
  it("lists only session-owned participation history with a bounded cursor", async () => {
    const listOwnHistory = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            participantId,
            jobId,
            providerDisplayName: "Provider",
            municipalityName: "Obec",
            primaryProfessionCode: "TEST:WORK",
            invitedAt,
            state: "ACCEPTED",
            acceptedAt: invitedAt,
            leftAt: null,
          },
        ],
        nextCursor: { invitedAt, id: participantId },
      }),
    );
    const { app } = build({ listOwnHistory });
    const response = await app.inject({
      method: "GET",
      url: `${JOB_PARTICIPATION_PATHS.history}?limit=20&beforeAt=${encodeURIComponent(invitedAt.toISOString())}&beforeId=${participantId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).not.toContain("exactAddress");
    expect(listOwnHistory).toHaveBeenCalledWith({
      actorUserId,
      cursor: { invitedAt, id: participantId },
      limit: 20,
    });
  });

  it("reads only the invitee inbox with bounded cursor and no-store headers", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            participantId,
            jobId,
            invitedAt,
            providerDisplayName: "Provider",
            municipalityName: "Obec",
            primaryProfessionCode: "TEST:WORK",
          },
        ],
        nextCursor: { invitedAt, id: participantId },
      }),
    );
    const { app } = build({ list });
    const response = await app.inject({
      method: "GET",
      url: `${JOB_PARTICIPATION_PATHS.inbox}?limit=20&beforeAt=${encodeURIComponent(invitedAt.toISOString())}&beforeId=${participantId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(list).toHaveBeenCalledWith({
      actorUserId,
      cursor: { invitedAt, id: participantId },
      limit: 20,
    });
    expect(response.body).not.toContain("exactAddress");
  });

  it("uses session-derived actor for invite and explicit decision", async () => {
    const invite = vi.fn(() =>
      Promise.resolve({ status: "APPLIED", participantId, invitedAt }),
    );
    const decide = vi.fn(() =>
      Promise.resolve({
        status: "APPLIED",
        state: "ACCEPTED",
        recordedAt: invitedAt,
      }),
    );
    const { app } = build({ invite, decide });
    const invited = await app.inject({
      method: "POST",
      url: inviteUrl,
      payload: { commandId, craftsmanProfileId },
    });
    expect(invited.statusCode).toBe(201);
    expect(invite).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfileId,
      jobId,
    });
    const accepted = await app.inject({
      method: "POST",
      url: decisionUrl,
      payload: { commandId, decision: "ACCEPT" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(decide).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      decision: "ACCEPT",
      participantId,
    });
    expect(accepted.json()).toEqual({
      status: "APPLIED",
      state: "ACCEPTED",
      recordedAt: invitedAt.toISOString(),
    });
  });

  it("uses the session actor for role changes and returns only the bounded result", async () => {
    const changeRole = vi.fn(() =>
      Promise.resolve({
        status: "APPLIED",
        role: "LEAD",
        active: true,
        recordedAt: invitedAt,
      }),
    );
    const { app } = build({ changeRole });
    const response = await app.inject({
      method: "POST",
      url: roleUrl,
      payload: { commandId, role: "LEAD", action: "ASSIGN" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(changeRole).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      participantId,
      role: "LEAD",
      action: "ASSIGN",
    });
    expect(response.json()).toEqual({
      status: "APPLIED",
      role: "LEAD",
      active: true,
      recordedAt: invitedAt.toISOString(),
    });
  });

  it("denies missing/inactive sessions without querying private state", async () => {
    const list = vi.fn();
    const listOwnHistory = vi.fn();
    const invite = vi.fn();
    const decide = vi.fn();
    const changeRole = vi.fn();
    for (const [status, code] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app } = build({
        status,
        list,
        listOwnHistory,
        invite,
        decide,
        changeRole,
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: JOB_PARTICIPATION_PATHS.inbox,
          })
        ).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "GET",
            url: JOB_PARTICIPATION_PATHS.history,
          })
        ).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "POST",
            url: inviteUrl,
            payload: { commandId, craftsmanProfileId },
          })
        ).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "POST",
            url: decisionUrl,
            payload: { commandId, decision: "ACCEPT" },
          })
        ).statusCode,
      ).toBe(code);
      expect(
        (
          await app.inject({
            method: "POST",
            url: roleUrl,
            payload: { commandId, role: "LEAD", action: "ASSIGN" },
          })
        ).statusCode,
      ).toBe(code);
    }
    expect(list).not.toHaveBeenCalled();
    expect(listOwnHistory).not.toHaveBeenCalled();
    expect(invite).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(changeRole).not.toHaveBeenCalled();
  });

  it("rejects malformed input, masks foreign entities and redacts storage errors", async () => {
    const list = vi.fn(() => Promise.reject(new Error("private roster key")));
    const listOwnHistory = vi.fn(() =>
      Promise.reject(new Error("private history key")),
    );
    const invite = vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
    const decide = vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
    const changeRole = vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
    const { app } = build({
      list,
      listOwnHistory,
      invite,
      decide,
      changeRole,
    });
    for (const suffix of [
      "?limit=51",
      `?beforeId=${participantId}`,
      "?extra=secret",
      "?limit=1&limit=2",
    ]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${JOB_PARTICIPATION_PATHS.inbox}${suffix}`,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${JOB_PARTICIPATION_PATHS.history}?beforeId=${participantId}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(listOwnHistory).not.toHaveBeenCalled();
    const failure = await app.inject({
      method: "GET",
      url: JOB_PARTICIPATION_PATHS.inbox,
    });
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("private roster key");
    const historyFailure = await app.inject({
      method: "GET",
      url: JOB_PARTICIPATION_PATHS.history,
    });
    expect(historyFailure.statusCode).toBe(503);
    expect(historyFailure.body).not.toContain("private history key");
    expect(
      (
        await app.inject({
          method: "POST",
          url: inviteUrl,
          payload: { commandId, craftsmanProfileId, actorUserId },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionUrl,
          payload: { commandId, decision: "ACCEPT", extra: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: inviteUrl,
          payload: { commandId, craftsmanProfileId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: decisionUrl,
          payload: { commandId, decision: "ACCEPT" },
        })
      ).statusCode,
    ).toBe(404);
    for (const payload of [
      { commandId, role: "LEAD", action: "ASSIGN", actorUserId },
      { commandId, role: "MEMBER", action: "ASSIGN" },
      { commandId, role: "LEAD", action: "DELETE" },
    ]) {
      expect(
        (await app.inject({ method: "POST", url: roleUrl, payload }))
          .statusCode,
      ).toBe(400);
    }
    expect(changeRole).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: roleUrl,
          payload: { commandId, role: "LEAD", action: "ASSIGN" },
        })
      ).statusCode,
    ).toBe(404);
  });
});
