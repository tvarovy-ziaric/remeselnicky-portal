import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import {
  JOB_PARTICIPATION_DETAIL_PATH,
  registerJobParticipationDetailRoute,
} from "./routes.js";

const actorUserId = "86200000-0000-4000-8000-000000000001" as UserId;
const participantId = "86200000-0000-4000-8000-000000000002";
const jobId = "86200000-0000-4000-8000-000000000003";
const at = new Date("2026-09-16T09:00:00.000Z");
const url = JOB_PARTICIPATION_DETAIL_PATH.replace(
  ":participantId",
  participantId,
);
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(input?: {
  readonly status?: "ACTIVE" | "ACCOUNT_NOT_ACTIVE" | "AUTHENTICATION_REQUIRED";
  readonly getForViewer?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  const getForViewer =
    input?.getForViewer ?? vi.fn(() => Promise.resolve(null));
  registerJobParticipationDetailRoute(app, {
    detail: { getForViewer },
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
  return { app, getForViewer };
}

describe("private exact Job participation detail", () => {
  it("uses the session actor and returns only privacy-minimal context", async () => {
    const getForViewer = vi.fn(() =>
      Promise.resolve({
        participantId,
        jobId,
        viewerRole: "PARTICIPANT",
        state: "INVITED",
        jobState: "CONFIRMED",
        participantDisplayName: "Pomocník",
        providerDisplayName: "Majster",
        municipalityName: "Bratislava",
        primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
        invitedAt: at,
        acceptedAt: null,
        leftAt: null,
        verifiedCompletedWork: false,
        verifiedProfessionCodes: [],
        verifiedRoles: [],
        canDecide: true,
        canLeave: false,
      }),
    );
    const { app } = build({ getForViewer });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(getForViewer).toHaveBeenCalledWith({
      actorUserId,
      participantId,
    });
    expect(response.json()).toMatchObject({
      participantId,
      viewerRole: "PARTICIPANT",
      canDecide: true,
      verifiedCompletedWork: false,
      verifiedProfessionCodes: [],
      verifiedRoles: [],
    });
    expect(response.body).not.toMatch(/exactAddress|customerContact|reason/u);
  });

  it("denies absent or inactive sessions before private lookup", async () => {
    const getForViewer = vi.fn();
    for (const [status, expected] of [
      ["AUTHENTICATION_REQUIRED", 401],
      ["ACCOUNT_NOT_ACTIVE", 403],
    ] as const) {
      const { app } = build({ status, getForViewer });
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(expected);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
    expect(getForViewer).not.toHaveBeenCalled();
  });

  it("returns uniform 404 for foreign identities and rejects malformed IDs/query", async () => {
    const { app, getForViewer } = build();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: JOB_PARTICIPATION_DETAIL_PATH.replace(":participantId", "bad"),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `${url}?debug=1` })).statusCode,
    ).toBe(400);
    expect(getForViewer).toHaveBeenCalledTimes(1);
  });

  it("redacts database failures", async () => {
    const getForViewer = vi.fn(() =>
      Promise.reject(new Error("private participant storage key")),
    );
    const { app } = build({ getForViewer });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private participant storage key");
  });
});
