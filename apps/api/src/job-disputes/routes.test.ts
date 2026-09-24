import type { createJobDisputeRepository } from "@portal/db";
import type { UserId } from "@portal/domain";
import type { DisputeEvidenceUploadService } from "@portal/media";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HookHandlerDoneFunction,
} from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JOB_DISPUTE_PATHS, registerJobDisputeRoutes } from "./routes.js";

type Repository = ReturnType<typeof createJobDisputeRepository>;
const actorUserId = "a2100000-0000-4000-8000-000000000001" as UserId;
const jobId = "a2100000-0000-4000-8000-000000000002";
const disputeId = "a2100000-0000-4000-8000-000000000003";
const commandId = "a2100000-0000-4000-8000-000000000004";
const mediaAssetId = "a2100000-0000-4000-8000-000000000005";
const occurredAt = new Date("2026-09-24T17:30:00.000Z");
const apps: FastifyInstance[] = [];

function build(
  status:
    "ACTIVE" | "AUTHENTICATION_REQUIRED" | "ACCOUNT_NOT_ACTIVE" = "ACTIVE",
) {
  const app = Fastify();
  const openCase = vi.fn<Repository["openCase"]>(() =>
    Promise.resolve({
      status: "APPLIED",
      id: disputeId,
      disputeId,
      occurredAt,
    }),
  );
  const listCases = vi.fn<Repository["listCases"]>(() =>
    Promise.resolve([
      {
        id: disputeId,
        jobId,
        openedByRole: "CUSTOMER",
        viewerRole: "CUSTOMER",
        category: "QUALITY_DEFECT",
        description: "Výsledok má viditeľnú vadu povrchu.",
        desiredResolution: "Oprava povrchu.",
        state: "OPEN",
        stateRevision: 1,
        createdAt: occurredAt,
        stateChangedAt: occurredAt,
        canAddContent: true,
      },
    ]),
  );
  const getCase = vi.fn<Repository["getCase"]>(() =>
    Promise.resolve({
      id: disputeId,
      jobId,
      openedByRole: "CUSTOMER",
      viewerRole: "CUSTOMER",
      category: "QUALITY_DEFECT",
      description: "Výsledok má viditeľnú vadu povrchu.",
      desiredResolution: "Oprava povrchu.",
      state: "OPEN",
      stateRevision: 1,
      createdAt: occurredAt,
      stateChangedAt: occurredAt,
      canAddContent: true,
      statements: [],
      evidence: [],
      commercialBaseline: {
        acceptedRequestContentRevision: 1,
        acceptedRequestVisibleVersion: 1,
        acceptedQuoteId: commandId,
        acceptedQuoteRevision: 1,
        acceptedQuoteMode: "PLATFORM_STRUCTURED",
        acceptedQuotePdfDownloadPath: null,
        approvedChanges: [],
        jobDashboardPath: `/zakazky/${jobId}`,
      },
      jobTimeline: [],
    }),
  );
  const addStatement = vi.fn<Repository["addStatement"]>(() =>
    Promise.resolve({
      status: "APPLIED",
      id: commandId,
      disputeId,
      occurredAt,
    }),
  );
  const addEvidence = vi.fn<Repository["addEvidence"]>(() =>
    Promise.resolve({
      status: "APPLIED",
      id: commandId,
      disputeId,
      occurredAt,
    }),
  );
  const getEvidenceUploadStatus = vi.fn<Repository["getEvidenceUploadStatus"]>(
    () => Promise.resolve({ status: "READY", canBind: true }),
  );
  const upload = vi.fn<DisputeEvidenceUploadService["upload"]>(() =>
    Promise.resolve({
      assetId: mediaAssetId,
      kind: "PDF",
      status: "PROCESSING",
    }),
  );
  const csrfProtection = vi.fn(
    (
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
  );
  registerJobDisputeRoutes(app, {
    disputes: {
      addEvidence,
      addStatement,
      getCase,
      getEvidenceUploadStatus,
      listCases,
      openCase,
    },
    evidenceUploads: { upload },
    csrfProtection,
    guard: {
      evaluate: () =>
        Promise.resolve(
          status === "ACTIVE"
            ? { status: "ACTIVE" as const, user: { id: actorUserId } }
            : { status },
        ),
    },
    rateLimit: {
      read: { max: 30, timeWindowMs: 60_000 },
      write: { max: 5, timeWindowMs: 60_000 },
    },
  });
  apps.push(app);
  return {
    app,
    openCase,
    listCases,
    getCase,
    addStatement,
    addEvidence,
    upload,
  };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const casesPath = JOB_DISPUTE_PATHS.cases.replace(":jobId", jobId);
const detailPath = JOB_DISPUTE_PATHS.detail
  .replace(":jobId", jobId)
  .replace(":disputeId", disputeId);

describe("Job dispute routes", () => {
  it("lists only session-authorized private cases", async () => {
    const { app, listCases } = build();
    const response = await app.inject({ method: "GET", url: casesPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(
      response.json<{ items: { state: string }[] }>().items[0]?.state,
    ).toBe("OPEN");
    expect(listCases).toHaveBeenCalledWith({ actorUserId, jobId });
  });

  it("opens a dispute with CSRF and no client-selected state or outcome", async () => {
    const { app, openCase } = build();
    const payload = {
      commandId,
      category: "QUALITY_DEFECT",
      description: "Výsledok má viditeľnú vadu povrchu.",
      desiredResolution: "Oprava povrchu.",
    };
    expect(
      (await app.inject({ method: "POST", url: casesPath, payload }))
        .statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: "POST",
      url: casesPath,
      headers: { "x-csrf-token": "valid" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(openCase).toHaveBeenCalledWith({ actorUserId, jobId, ...payload });
    for (const field of ["state", "outcome", "jobState"]) {
      const invalid = await app.inject({
        method: "POST",
        url: casesPath,
        headers: { "x-csrf-token": "valid" },
        payload: { ...payload, [field]: "RESOLVED" },
      });
      expect(invalid.statusCode).toBe(400);
    }
  });

  it("reads the immutable baseline and appends statements and evidence", async () => {
    const { app, addStatement, addEvidence } = build();
    const detail = await app.inject({ method: "GET", url: detailPath });
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{
        commercialBaseline: {
          acceptedQuoteRevision: number;
          jobDashboardPath: string;
        };
      }>().commercialBaseline,
    ).toMatchObject({
      acceptedQuoteRevision: 1,
      jobDashboardPath: `/zakazky/${jobId}`,
    });
    const statementPayload = {
      commandId,
      kind: "STATEMENT",
      body: "Uvádzam vlastný opis udalostí.",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${detailPath}/statements`,
          headers: { "x-csrf-token": "valid" },
          payload: statementPayload,
        })
      ).statusCode,
    ).toBe(201);
    expect(addStatement).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      disputeId,
      ...statementPayload,
    });
    const evidencePayload = {
      commandId,
      source: "EXISTING_JOB_EVIDENCE",
      mediaAssetId,
      description: "Fotografia výsledku z dokumentácie zákazky.",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${detailPath}/evidence`,
          headers: { "x-csrf-token": "valid" },
          payload: evidencePayload,
        })
      ).statusCode,
    ).toBe(201);
    expect(addEvidence).toHaveBeenCalledWith({
      actorUserId,
      jobId,
      disputeId,
      ...evidencePayload,
    });
  });

  it("uploads only bounded central photo/PDF evidence", async () => {
    const { app, upload } = build();
    const uploadPath = JOB_DISPUTE_PATHS.evidenceUpload
      .replace(":jobId", jobId)
      .replace(":disputeId", disputeId)
      .replace(":mediaKind", "documents");
    const response = await app.inject({
      method: "POST",
      url: uploadPath,
      headers: {
        "content-type": "application/pdf",
        "x-csrf-token": "valid",
      },
      payload: Buffer.from("%PDF-1.7"),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      assetId: mediaAssetId,
      kind: "PDF",
      status: "PROCESSING",
    });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        disputeId,
        declaredContentType: "application/pdf",
        mediaKind: "PDF",
      }),
    );
  });

  it.each([
    ["AUTHENTICATION_REQUIRED", 401],
    ["ACCOUNT_NOT_ACTIVE", 403],
  ] as const)("denies %s before case persistence", async (status, expected) => {
    const { app, listCases } = build(status);
    expect(
      (await app.inject({ method: "GET", url: casesPath })).statusCode,
    ).toBe(expected);
    expect(listCases).not.toHaveBeenCalled();
  });
});
