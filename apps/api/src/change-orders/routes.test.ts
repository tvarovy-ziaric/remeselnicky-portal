import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserId } from "@portal/domain";

import { registerChangeOrderRoutes } from "./routes.js";

const actorUserId = "f2100000-0000-4000-8000-000000000001" as UserId;
const jobId = "f2100000-0000-4000-8000-000000000002";
const changeOrderId = "f2100000-0000-4000-8000-000000000003";
const revisionId = "f2100000-0000-4000-8000-000000000004";
const commandId = "f2100000-0000-4000-8000-000000000005";
const mediaAssetId = "f2100000-0000-4000-8000-000000000006";
const at = new Date("2026-09-17T09:00:00.000Z");
const terms = {
  title: "Doplnenie izolácie",
  reason: "Skrytá porucha",
  changeDescription: "Pridať izoláciu",
  scopeAdded: ["Izolácia"],
  scopeRemoved: [],
  scopeChanged: [],
  priceImpact: {
    mode: "FIXED_DELTA" as const,
    amountCents: 50000,
    vatStatus: "VAT_INCLUDED" as const,
  },
  scheduleImpact: { mode: "DAYS" as const, deltaDays: 2 },
};
const revision = {
  revisionId,
  revisionNumber: 1,
  state: "PROPOSED" as const,
  authoredSide: "PRIMARY_PROVIDER" as const,
  terms: { ...terms, externalPdfDownloadPath: null },
  pdfContentSha256: null,
  createdAt: at,
  stateChangedAt: at,
};
const success = {
  status: "APPLIED" as const,
  changeOrderId,
  revisionId,
  revisionNumber: 1,
  state: "PROPOSED" as const,
  occurredAt: at,
};
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
  mediaEnabled = false,
) {
  const app = Fastify();
  const changeOrders = {
    list: vi.fn(() =>
      Promise.resolve({
        items: [
          {
            changeOrderId,
            revisionId,
            revisionNumber: 1,
            state: "PROPOSED" as const,
            title: terms.title,
            authoredSide: "PRIMARY_PROVIDER" as const,
            createdAt: at,
          },
        ],
        nextCursor: null,
      }),
    ),
    get: vi.fn(() =>
      Promise.resolve({
        changeOrderId,
        jobId,
        createdBySide: "PRIMARY_PROVIDER" as const,
        createdAt: at,
        revisions: [revision],
        actions: [
          {
            id: commandId,
            revisionId,
            sequence: 1,
            action: "PROPOSE",
            supersededByRevisionId: null,
            occurredAt: at,
          },
        ],
      }),
    ),
    listRevisions: vi.fn(() =>
      Promise.resolve({ items: [revision], nextCursor: null }),
    ),
    getRevision: vi.fn(() => Promise.resolve(revision)),
    create: vi.fn(() => Promise.resolve(success)),
    replace: vi.fn(() => Promise.resolve(success)),
    counterpropose: vi.fn(() => Promise.resolve(success)),
    propose: vi.fn(() => Promise.resolve(success)),
    approve: vi.fn(() => Promise.resolve(success)),
    reject: vi.fn(() => Promise.resolve(success)),
    withdraw: vi.fn(() => Promise.resolve(success)),
  };
  const guard = {
    evaluate: vi.fn(() =>
      Promise.resolve(
        status === "ACTIVE"
          ? { status: "ACTIVE" as const, user: { id: actorUserId } }
          : { status },
      ),
    ),
  };
  const csrfProtection = vi.fn(
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      if (request.headers["x-csrf-token"] !== "valid") {
        void reply.code(403).send({ code: "INVALID_CSRF" });
        return;
      }
      done();
    },
  );
  const pdfReservations = {
    reserve: vi.fn(() =>
      Promise.resolve({
        status: "AUTHORIZED" as const,
        reservationId: changeOrderId,
        revisionNumber: 1,
        expiresAt: at,
      }),
    ),
    readStatus: vi.fn(() =>
      Promise.resolve({
        status: "PROCESSING" as const,
        expiresAt: at,
        canCreateRevision: true,
      }),
    ),
  };
  const documentUploads = {
    upload: vi.fn(() =>
      Promise.resolve({ status: "PROCESSING" as const, assetId: revisionId }),
    ),
  };
  registerChangeOrderRoutes(app, {
    changeOrders,
    guard,
    csrfProtection,
    rateLimit: { max: 20, timeWindowMs: 60_000 },
    ...(mediaEnabled ? { pdfReservations, documentUploads } : {}),
  });
  apps.push(app);
  return { app, changeOrders, guard, pdfReservations, documentUploads };
}
const collection = `/v1/me/jobs/${jobId}/change-orders`;
const detail = `${collection}/${changeOrderId}`;

describe("Change-order private HTTP transport", () => {
  it("reads only exact provider-bound PDF readiness with private headers and uniform denial", async () => {
    const url = `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf/${mediaAssetId}/status`;
    const { app, pdfReservations } = build("ACTIVE", true);
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "PROCESSING",
      expiresAt: at.toISOString(),
      canCreateRevision: true,
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(pdfReservations.readStatus).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      revisionId,
      mediaAssetId,
    });
    pdfReservations.readStatus.mockResolvedValueOnce(null as never);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `${url}?probe=1` })).statusCode,
    ).toBe(400);
    const anonymous = build("AUTHENTICATION_REQUIRED", true);
    expect(
      (await anonymous.app.inject({ method: "GET", url })).statusCode,
    ).toBe(401);
    expect(anonymous.pdfReservations.readStatus).not.toHaveBeenCalled();
  });

  it("reserves an exact future PDF revision and uploads only as PROCESSING", async () => {
    const { app, pdfReservations, documentUploads } = build("ACTIVE", true);
    const headers = { "x-csrf-token": "valid" };
    const reservation = await app.inject({
      method: "POST",
      url: `/v1/me/jobs/${jobId}/change-order-pdf-reservations`,
      headers,
      payload: {
        commandId: changeOrderId,
        changeOrderId,
        revisionId,
        expectedRevisionId: null,
      },
    });
    expect(reservation.statusCode).toBe(201);
    expect(reservation.json()).toEqual({
      status: "AUTHORIZED",
      reservationId: changeOrderId,
      revisionNumber: 1,
      expiresAt: at.toISOString(),
    });
    expect(pdfReservations.reserve).toHaveBeenCalledWith({
      actorUserId,
      commandId: changeOrderId,
      jobId,
      changeOrderId,
      revisionId,
      expectedRevisionId: null,
    });
    const upload = await app.inject({
      method: "POST",
      url: `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf`,
      headers: { ...headers, "content-type": "application/pdf" },
      payload: Buffer.from("%PDF-1.7\nsynthetic"),
    });
    expect(upload.statusCode).toBe(202);
    expect(upload.json()).toEqual({
      status: "PROCESSING",
      assetId: revisionId,
    });
    expect(documentUploads.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        revisionId,
        declaredContentType: "application/pdf",
      }),
    );
    expect(upload.headers["cache-control"]).toBe("private, no-store");
  });

  it("fails closed without media runtime, active session, CSRF or valid PDF body", async () => {
    const reservationUrl = `/v1/me/jobs/${jobId}/change-order-pdf-reservations`;
    const uploadUrl = `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf`;
    const payload = {
      commandId: changeOrderId,
      changeOrderId,
      revisionId,
      expectedRevisionId: null,
    };
    const noMedia = build();
    expect(
      (
        await noMedia.app.inject({
          method: "POST",
          url: reservationUrl,
          headers: { "x-csrf-token": "valid" },
          payload,
        })
      ).statusCode,
    ).toBe(503);
    expect(noMedia.pdfReservations.reserve).not.toHaveBeenCalled();
    const anonymous = build("AUTHENTICATION_REQUIRED", true);
    expect(
      (
        await anonymous.app.inject({
          method: "POST",
          url: reservationUrl,
          headers: { "x-csrf-token": "valid" },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(anonymous.pdfReservations.reserve).not.toHaveBeenCalled();
    const active = build("ACTIVE", true);
    expect(
      (
        await active.app.inject({
          method: "POST",
          url: reservationUrl,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const invalid = await active.app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { "x-csrf-token": "valid", "content-type": "text/plain" },
      payload: "not a PDF",
    });
    expect(invalid.statusCode).toBe(400);
    expect(active.documentUploads.upload).not.toHaveBeenCalled();
    const extra = await active.app.inject({
      method: "POST",
      url: reservationUrl,
      headers: { "x-csrf-token": "valid" },
      payload: { ...payload, providerUserId: actorUserId },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("lists only actor-scoped records with no-store and rejects duplicate/partial cursors", async () => {
    const { app, changeOrders } = build();
    const good = await app.inject({ method: "GET", url: collection });
    expect(good.statusCode).toBe(200);
    expect(good.headers["cache-control"]).toBe("private, no-store");
    expect(good.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(changeOrders.list).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      limit: 20,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${collection}?afterId=${changeOrderId}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${collection}?limit=2&limit=3`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("requires active session and CSRF before commercial commands", async () => {
    const anonymous = build("AUTHENTICATION_REQUIRED");
    const body = { commandId, revisionId, terms };
    const read = await anonymous.app.inject({ method: "GET", url: detail });
    expect(read.statusCode).toBe(401);
    const write = await anonymous.app.inject({
      method: "POST",
      url: collection,
      headers: { "x-csrf-token": "valid" },
      payload: body,
    });
    expect(write.statusCode).toBe(401);
    expect(anonymous.changeOrders.create).not.toHaveBeenCalled();
    const inactive = build("ACCOUNT_NOT_ACTIVE");
    expect(
      (await inactive.app.inject({ method: "GET", url: detail })).statusCode,
    ).toBe(403);
    const active = build();
    expect(
      (
        await active.app.inject({
          method: "POST",
          url: collection,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(active.changeOrders.create).not.toHaveBeenCalled();
  });

  it("passes an exact create and revision decision, rejects excess nested terms and reserved PDF", async () => {
    const { app, changeOrders } = build();
    const headers = { "x-csrf-token": "valid" };
    const create = await app.inject({
      method: "POST",
      url: collection,
      headers,
      payload: { commandId, revisionId, terms },
    });
    expect(create.statusCode, create.body).toBe(201);
    expect(changeOrders.create).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      commandId,
      revisionId,
      terms,
    });
    const approve = await app.inject({
      method: "POST",
      url: `${detail}/approve`,
      headers,
      payload: { commandId, revisionId, revisionNumber: 1 },
    });
    expect(approve.statusCode).toBe(200);
    expect(changeOrders.approve).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      changeOrderId,
      commandId,
      revisionId,
      revisionNumber: 1,
    });
    const extra = await app.inject({
      method: "POST",
      url: collection,
      headers,
      payload: {
        commandId,
        revisionId,
        terms: { ...terms, priceImpact: { mode: "NONE", leaked: true } },
      },
    });
    expect(extra.statusCode).toBe(400);
    const pdf = await app.inject({
      method: "POST",
      url: collection,
      headers,
      payload: {
        commandId,
        revisionId,
        terms: { ...terms, externalPdfMediaAssetId: revisionId },
      },
    });
    expect(pdf.statusCode).toBe(201);
    expect(changeOrders.create).toHaveBeenCalledTimes(2);
  });

  it("keeps exact revision reads private and maps hidden/stale outcomes without leaking persistence errors", async () => {
    const { app, changeOrders } = build();
    const response = await app.inject({
      method: "GET",
      url: `${detail}/revisions/${revisionId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(changeOrders.getRevision).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      changeOrderId,
      revisionId,
    });
    changeOrders.getRevision.mockResolvedValueOnce(null as never);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${detail}/revisions/${revisionId}`,
        })
      ).statusCode,
    ).toBe(404);
    changeOrders.approve.mockResolvedValueOnce({
      status: "STALE_STATE",
    } as never);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${detail}/approve`,
          headers: { "x-csrf-token": "valid" },
          payload: { commandId, revisionId, revisionNumber: 1 },
        })
      ).statusCode,
    ).toBe(409);
    changeOrders.approve.mockRejectedValueOnce(
      new Error("secret database detail"),
    );
    const unavailable = await app.inject({
      method: "POST",
      url: `${detail}/approve`,
      headers: { "x-csrf-token": "valid" },
      payload: { commandId, revisionId, revisionNumber: 1 },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("secret database detail");
  });
});
