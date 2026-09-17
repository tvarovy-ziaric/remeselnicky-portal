import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import {
  JOB_PARTICIPANT_CAPABILITY_PATHS,
  registerJobParticipantCapabilityRoutes,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const participantId = "86200000-0000-4000-8000-000000000002";
const claimId = "86200000-0000-4000-8000-000000000003";
const commandId = "86200000-0000-4000-8000-000000000004";
const proposedAt = new Date("2026-09-16T18:00:00.000Z");
const collection = JOB_PARTICIPANT_CAPABILITY_PATHS.collection.replace(
  ":participantId",
  participantId,
);
const confirm = JOB_PARTICIPANT_CAPABILITY_PATHS.confirm
  .replace(":participantId", participantId)
  .replace(":claimId", claimId);
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  list?: ReturnType<typeof vi.fn>;
  propose?: ReturnType<typeof vi.fn>;
  confirm?: ReturnType<typeof vi.fn>;
  csrfDenied?: boolean;
}) {
  const app = Fastify();
  const list = input?.list ?? vi.fn(() => Promise.resolve(null));
  const propose =
    input?.propose ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  const confirmCommand =
    input?.confirm ?? vi.fn(() => Promise.resolve({ status: "NOT_FOUND" }));
  registerJobParticipantCapabilityRoutes(app, {
    capabilities: { list, propose, confirm: confirmCommand },
    csrfProtection: (_request, reply, done) =>
      input?.csrfDenied
        ? void reply.code(403).send({ code: "CSRF_INVALID" })
        : done(),
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
  return { app, list, propose, confirmCommand };
}

describe("private Job participant capability routes", () => {
  it("requires session and exposes only a private bounded cursor list", async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            claimId,
            participantId,
            kind: "CUSTOM_SKILL",
            professionTaxonomyReleaseId: null,
            professionCode: null,
            skillCatalogReleaseId: null,
            skillCode: null,
            customSkillText: "Ručné omietanie",
            proposedByUserId: actorUserId,
            proposedAt,
            confirmedByUserId: null,
            confirmedAt: null,
            status: "PROPOSED",
            canConfirm: false,
          },
        ],
        canAct: true,
        canPropose: true,
        nextCursor: { proposedAt, id: claimId },
      }),
    );
    const { app } = build({ list });
    const response = await app.inject({
      method: "GET",
      url: `${collection}?limit=10&beforeAt=${encodeURIComponent(proposedAt.toISOString())}&beforeId=${claimId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      canAct: true,
      canPropose: true,
      nextCursor: { proposedAt: proposedAt.toISOString(), id: claimId },
      items: [{ status: "PROPOSED", confirmedAt: null }],
    });
    expect(response.body).not.toContain("exactAddress");
    expect(list).toHaveBeenCalledWith({
      actorUserId,
      participantId,
      limit: 10,
      cursor: { proposedAt, id: claimId },
    });
    expect(
      (await app.inject({ method: "GET", url: `${collection}?limit=51` }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${collection}?beforeId=${claimId}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${collection}?unexpected=1` }))
        .statusCode,
    ).toBe(400);
  });

  it("masks nonparty and unauthenticated reads", async () => {
    expect(
      (await build().app.inject({ method: "GET", url: collection })).statusCode,
    ).toBe(404);
    const denied = build({ status: "AUTHENTICATION_REQUIRED" });
    expect(
      (await denied.app.inject({ method: "GET", url: collection })).statusCode,
    ).toBe(401);
    expect(denied.list).not.toHaveBeenCalled();
  });

  it("uses CSRF, exact variant shape and status mapping for proposals", async () => {
    const propose = vi.fn(() =>
      Promise.resolve({
        status: "APPLIED",
        claimId,
        claimStatus: "PROPOSED",
        proposedAt,
      }),
    );
    const { app } = build({ propose });
    const response = await app.inject({
      method: "POST",
      url: collection,
      payload: {
        commandId,
        kind: "CUSTOM_SKILL",
        customSkillText: "Ručné omietanie",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      status: "APPLIED",
      claimId,
      claimStatus: "PROPOSED",
      proposedAt: proposedAt.toISOString(),
    });
    expect(propose).toHaveBeenCalledWith({
      actorUserId,
      participantId,
      commandId,
      kind: "CUSTOM_SKILL",
      customSkillText: "Ručné omietanie",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: collection,
          payload: {
            commandId,
            kind: "CUSTOM_SKILL",
            customSkillText: "x",
            professionCode: "TEST:WORK",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: collection,
          payload: { commandId, kind: "PROFESSION" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await build({ csrfDenied: true }).app.inject({
          method: "POST",
          url: collection,
          payload: {
            commandId,
            kind: "PROFESSION",
            professionCode: "TEST:WORK",
          },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("confirms through exact CSRF command and never exposes denied claims", async () => {
    const confirmCommand = vi.fn(() =>
      Promise.resolve({
        status: "APPLIED",
        claimId,
        claimStatus: "CONFIRMED",
        confirmedAt: proposedAt,
      }),
    );
    const { app } = build({ confirm: confirmCommand });
    const response = await app.inject({
      method: "POST",
      url: confirm,
      payload: { commandId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "APPLIED",
      claimId,
      claimStatus: "CONFIRMED",
      confirmedAt: proposedAt.toISOString(),
    });
    expect(confirmCommand).toHaveBeenCalledWith({
      actorUserId,
      participantId,
      claimId,
      commandId,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: confirm,
          payload: { commandId, actorUserId },
        })
      ).statusCode,
    ).toBe(400);
    const denied = build({
      confirm: vi.fn(() => Promise.resolve({ status: "NOT_FOUND" })),
    });
    expect(
      (
        await denied.app.inject({
          method: "POST",
          url: confirm,
          payload: { commandId },
        })
      ).statusCode,
    ).toBe(404);
  });
});
