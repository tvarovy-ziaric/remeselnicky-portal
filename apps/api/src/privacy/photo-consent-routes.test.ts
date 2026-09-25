import type { UserId } from "@portal/domain";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JOB_PROPERTY_PHOTO_CONSENT_PATHS,
  registerJobPropertyPhotoConsentRoutes,
} from "./photo-consent-routes.js";

const customerUserId = "74000000-0000-4000-8000-000000000001" as UserId;
const jobId = "74000000-0000-4000-8000-000000000002";
const mediaAssetId = "74000000-0000-4000-8000-000000000003";
const policyVersionId = "74000000-0000-4000-8000-000000000004";
const eventId = "74000000-0000-4000-8000-000000000005";
const correlationId = "74000000-0000-4000-8000-000000000006";
const now = new Date("2026-09-25T10:00:00.000Z");
const listPath = JOB_PROPERTY_PHOTO_CONSENT_PATHS.list.replace(":jobId", jobId);
const itemPath = JOB_PROPERTY_PHOTO_CONSENT_PATHS.item
  .replace(":jobId", jobId)
  .replace(":mediaAssetId", mediaAssetId);
const body = {
  action: "GRANTED" as const,
  correlationId,
  eventId,
  expectedRevision: 0,
  policyVersionId,
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input?: {
  accountState?: "ACTIVE" | "DEACTIVATED" | "SUSPENDED";
  authenticated?: boolean;
}) {
  const accountState = input?.accountState ?? "ACTIVE";
  const app = Fastify();
  apps.push(app);
  const listForCustomerJob = vi.fn().mockResolvedValue({
    items: [
      {
        action: null,
        mediaAssetId,
        occurredAt: null,
        policyVersionId: null,
        revision: 0,
      },
    ],
    policy: {
      contentSha256: "a".repeat(64),
      policyVersionId,
      versionLabel: "property-photo-v1",
    },
  });
  const appendDecision = vi.fn().mockResolvedValue({
    event: {
      action: "GRANTED",
      correlationId,
      customerUserId,
      eventId,
      jobId,
      mediaAssetId,
      occurredAt: now,
      policyVersionId,
      revision: 1,
    },
    status: "APPENDED",
  });
  registerJobPropertyPhotoConsentRoutes(app, {
    consent: { appendDecision, listForCustomerJob },
    csrfProtection: (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ) => {
      if (request.headers["x-csrf-token"] !== "valid") {
        void reply.code(403).send({ code: "CSRF_INVALID" });
        return;
      }
      done();
    },
    guard: {
      evaluate: vi.fn().mockResolvedValue(
        input?.authenticated === false
          ? { status: "AUTHENTICATION_REQUIRED" }
          : accountState === "ACTIVE"
            ? {
                status: "ACTIVE",
                user: { accountState, id: customerUserId },
              }
            : {
                status: "ACCOUNT_NOT_ACTIVE",
                user: { accountState, id: customerUserId },
              },
      ),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
  });
  return { app, appendDecision, listForCustomerJob };
}

describe("Job property-photo consent routes", () => {
  it("lists only exact-photo decisions and approved policy identity", async () => {
    const { app, listForCustomerJob } = fixture();
    const response = await app.inject({ method: "GET", url: listPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      items: [
        {
          action: null,
          downloadPath: `/v1/media/${mediaAssetId}/download`,
          mediaAssetId,
          revision: 0,
        },
      ],
      policy: { policyVersionId, versionLabel: "property-photo-v1" },
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /storageKey|publicUrl|customerUserId/iu,
    );
    expect(listForCustomerJob).toHaveBeenCalledWith({ customerUserId, jobId });
  });

  it("records a separate consent decision with CSRF and session ownership", async () => {
    const consent = fixture();
    expect(
      (
        await consent.app.inject({
          method: "POST",
          payload: body,
          url: itemPath,
        })
      ).statusCode,
    ).toBe(403);
    const response = await consent.app.inject({
      headers: { "x-csrf-token": "valid" },
      method: "POST",
      payload: body,
      url: itemPath,
    });
    expect(response.statusCode).toBe(201);
    expect(consent.appendDecision).toHaveBeenCalledWith({
      ...body,
      customerUserId,
      jobId,
      mediaAssetId,
    });
  });

  it("keeps withdrawal available to a suspended customer", async () => {
    const suspended = fixture({ accountState: "SUSPENDED" });
    const response = await suspended.app.inject({
      headers: { "x-csrf-token": "valid" },
      method: "POST",
      payload: { ...body, action: "WITHDRAWN", expectedRevision: 1 },
      url: itemPath,
    });
    expect(response.statusCode).toBe(201);
    expect(suspended.appendDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: "WITHDRAWN", customerUserId }),
    );
  });

  it("fails closed for deactivated sessions, extra fields and unavailable policy", async () => {
    const deactivated = fixture({ accountState: "DEACTIVATED" });
    expect(
      (
        await deactivated.app.inject({
          method: "GET",
          url: listPath,
        })
      ).statusCode,
    ).toBe(403);

    const extra = fixture();
    expect(
      (
        await extra.app.inject({
          headers: { "x-csrf-token": "valid" },
          method: "POST",
          payload: { ...body, completionConfirmed: true },
          url: itemPath,
        })
      ).statusCode,
    ).toBe(400);
    expect(extra.appendDecision).not.toHaveBeenCalled();

    const unavailable = fixture();
    unavailable.appendDecision.mockResolvedValue({
      status: "POLICY_NOT_APPROVED",
    });
    expect(
      (
        await unavailable.app.inject({
          headers: { "x-csrf-token": "valid" },
          method: "POST",
          payload: body,
          url: itemPath,
        })
      ).statusCode,
    ).toBe(409);
  });
});
