import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  normalizeJobRequestDraftSection,
  type CustomerProfileId,
  type JobRequestDraftPersistence,
  type JobRequestDraftService,
  type JobRequestId,
  type UserId,
} from "@portal/domain";
import type { JobRequestMediaUploadService } from "@portal/media";

import {
  JOB_REQUEST_DRAFT_PATHS,
  registerJobRequestDraftRoutes,
  type JobRequestDraftRouteDependencies,
} from "./routes.js";

const actorId = "91000000-0000-4000-8000-000000000001" as UserId;
const customerId = "91000000-0000-4000-8000-000000000002" as CustomerProfileId;
const requestId = "91000000-0000-4000-8000-000000000003" as JobRequestId;
const commandId = "91000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-15T06:00:00.000Z");

describe("job request draft routes", () => {
  it("creates a private draft from one exact normalized content section", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestDraftRoutes(app, fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      payload: { commandId, section: coreSection() },
      url: JOB_REQUEST_DRAFT_PATHS.collection,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toEqual({
      id: requestId,
      revision: 1,
      savedAt: now.toISOString(),
      status: "APPLIED",
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    const input = fixture.create.mock.calls[0]?.[0];
    expect(input?.actorUserId).toBe(actorId);
    expect(input?.commandId).toBe(commandId);
    expect(input?.customerProfileId).toBe(customerId);
    expect(input?.section.key).toBe("request.core");
    expect(input?.section.schemaVersion).toBe(1);
    await app.close();
  });

  it("rejects unknown fields before calling persistence", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestDraftRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      payload: {
        commandId,
        section: {
          ...coreSection(),
          payload: { ...coreSection().payload, contactEmail: "x@example.com" },
        },
      },
      url: JOB_REQUEST_DRAFT_PATHS.collection,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(fixture.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns private recovery data only to the active session actor", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestDraftRoutes(app, fixture.dependencies);
    const response = await app.inject({
      method: "GET",
      url: `/v1/me/job-request-drafts/${requestId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      draft: {
        changedAt: now.toISOString(),
        createdAt: now.toISOString(),
        id: requestId,
        revision: 1,
        sections: [
          {
            ...coreSection(),
            savedAt: now.toISOString(),
          },
        ],
      },
    });
    expect(response.headers["cache-control"]).toBe("no-store");

    const unauthenticated = createFixture("AUTHENTICATION_REQUIRED");
    const deniedApp = Fastify();
    registerJobRequestDraftRoutes(deniedApp, unauthenticated.dependencies);
    const denied = await deniedApp.inject({
      method: "GET",
      url: `/v1/me/job-request-drafts/${requestId}`,
    });
    expect(denied.statusCode).toBe(401);
    expect(unauthenticated.recover).not.toHaveBeenCalled();
    await app.close();
    await deniedApp.close();
  });

  it("maps stale autosaves and missing activation requirements explicitly", async () => {
    const fixture = createFixture();
    fixture.autosave.mockResolvedValueOnce({
      currentRevision: 3,
      status: "STALE_REVISION",
    });
    const app = Fastify();
    registerJobRequestDraftRoutes(app, fixture.dependencies);

    const stale = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 2, section: coreSection() },
      url: `/v1/me/job-request-drafts/${requestId}/sections`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: "STALE_REVISION",
      currentRevision: 3,
    });

    const notReady = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 3 },
      url: `/v1/me/job-request-drafts/${requestId}/activate`,
    });
    expect(notReady.statusCode).toBe(422);
    expect(notReady.json()).toEqual({
      code: "NOT_READY",
      missingRequirements: ["MUNICIPALITY"],
    });
    await app.close();
  });

  it("accepts only private binary uploads at the current owned revision", async () => {
    const fixture = createFixture();
    const upload = vi.fn<JobRequestMediaUploadService["upload"]>(() =>
      Promise.resolve({
        assetId: "91000000-0000-4000-8000-000000000005",
        kind: "IMAGE",
        status: "PROCESSING",
      }),
    );
    const list = vi.fn<JobRequestMediaUploadService["list"]>(() =>
      Promise.resolve({
        status: "OK",
        uploads: [
          {
            assetId: "91000000-0000-4000-8000-000000000005",
            kind: "IMAGE",
            status: "PROCESSING",
          },
        ],
      }),
    );
    const app = Fastify();
    registerJobRequestDraftRoutes(app, {
      ...fixture.dependencies,
      mediaUploads: { list, upload },
    });
    const response = await app.inject({
      headers: {
        "content-type": "image/jpeg",
        "x-job-request-revision": "3",
      },
      method: "POST",
      payload: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      url: `/v1/me/job-request-drafts/${requestId}/media/photos`,
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      assetId: "91000000-0000-4000-8000-000000000005",
      kind: "IMAGE",
      status: "PROCESSING",
    });
    expect(JSON.stringify(response.json())).not.toMatch(/storage|filename/iu);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        jobRequestId: requestId,
        mediaKind: "IMAGE",
      }),
    );
    const statusResponse = await app.inject({
      method: "GET",
      url: `/v1/me/job-request-drafts/${requestId}/media`,
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toEqual({
      uploads: [
        {
          assetId: "91000000-0000-4000-8000-000000000005",
          kind: "IMAGE",
          status: "PROCESSING",
        },
      ],
    });
    await app.close();
  });

  it("fails closed when upload infrastructure or revision metadata is unavailable", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerJobRequestDraftRoutes(app, fixture.dependencies);
    const unavailable = await app.inject({
      headers: {
        "content-type": "application/pdf",
        "x-job-request-revision": "2",
      },
      method: "POST",
      payload: Buffer.from("%PDF-1.7\n%%EOF"),
      url: `/v1/me/job-request-drafts/${requestId}/media/documents`,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ code: "UPLOAD_UNAVAILABLE" });
    await app.close();
  });
});

function createFixture(
  guardStatus: "ACTIVE" | "AUTHENTICATION_REQUIRED" = "ACTIVE",
) {
  const create = vi.fn<
    JobRequestDraftPersistence["createDraftWithInitialSectionOwned"]
  >(() =>
    Promise.resolve({
      jobRequestId: requestId,
      revision: 1,
      savedAt: now,
      status: "APPLIED" as const,
    }),
  );
  const autosave = vi.fn<JobRequestDraftService["autosave"]>(() =>
    Promise.resolve({
      jobRequestId: requestId,
      revision: 2,
      savedAt: now,
      status: "APPLIED" as const,
    }),
  );
  const recover = vi.fn<JobRequestDraftService["recover"]>(() =>
    Promise.resolve({
      draft: {
        changedAt: now,
        createdAt: now,
        id: requestId,
        revision: 1,
        sections: [
          { ...normalizeJobRequestDraftSection(coreSection()), savedAt: now },
        ],
      },
      status: "OK" as const,
    }),
  );
  const dependencies = {
    csrfProtection: (_request, _reply, done) => done(),
    customerProfiles: {
      ensureForCustomerUse: () =>
        Promise.resolve({
          profile: {
            createdAt: now,
            id: customerId,
            ownerUserId: actorId,
            publicVisibility: "PRIVATE" as const,
            searchIndexing: "DISALLOWED" as const,
            updatedAt: now,
          },
          status: "EXISTING" as const,
        }),
    },
    draftPersistence: { createDraftWithInitialSectionOwned: create },
    drafts: {
      autosave,
      listRecent: () => Promise.resolve({ drafts: [], status: "OK" as const }),
      recover,
    },
    guard: {
      evaluate: () =>
        Promise.resolve(
          guardStatus === "ACTIVE"
            ? { status: "ACTIVE" as const, user: { id: actorId } }
            : { status: "AUTHENTICATION_REQUIRED" as const },
        ),
    },
    requests: {
      activate: () =>
        Promise.resolve({
          missingRequirements: ["MUNICIPALITY" as const],
          status: "NOT_READY" as const,
        }),
      createDraft: () => Promise.reject(new Error("not used")),
    },
  } satisfies JobRequestDraftRouteDependencies;
  return { autosave, create, dependencies, recover };
}

function coreSection() {
  return {
    key: "request.core",
    payload: {
      description: "Oprava strechy",
      primaryProfessionCode: null,
      relatedProfessionCodes: [],
      skillCodes: [],
      specializationCode: null,
      title: null,
    },
    schemaVersion: 1,
  } as const;
}
