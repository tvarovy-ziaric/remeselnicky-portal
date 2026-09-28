import type {
  CraftsmanProfileId,
  PortfolioProjectId,
  PortfolioProjectPhotoAttachmentId,
  UserId,
} from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- assertions target Vitest spies */

import {
  CRAFTSMAN_PORTFOLIO_PATHS,
  registerCraftsmanPortfolioRoutes,
  type CraftsmanPortfolioRouteDependencies,
} from "./routes.js";

const actorUserId = "9e330000-0000-4000-8000-000000000001" as UserId;
const profileId = "9e330000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const foreignProfileId =
  "9e330000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const projectId = "9e330000-0000-4000-8000-000000000004" as PortfolioProjectId;
const professionId = "9e330000-0000-4000-8000-000000000005";
const commandId = "9e330000-0000-4000-8000-000000000006";
const mediaAssetId = "9e330000-0000-4000-8000-000000000007";
const attachmentId =
  "9e330000-0000-4000-8000-000000000008" as PortfolioProjectPhotoAttachmentId;
const now = new Date("2026-09-28T12:00:00.000Z");

const project = {
  authorUserId: actorUserId,
  contribution: "Montáž a finálne škárovanie.",
  craftsmanProfileId: profileId,
  createdAt: now,
  districtCode: null,
  durationUnit: null,
  durationValue: null,
  evidenceStatus: "UNVERIFIED" as const,
  id: projectId,
  indicativePriceMaxCents: null,
  indicativePriceMinCents: null,
  materialsAndTechnologies: null,
  municipalityCode: null,
  problem: null,
  professionIds: [professionId] as never,
  provenanceKind: "SELF_DECLARED" as const,
  recordState: "DRAFT" as const,
  revision: 1,
  shortDescription: "Syntetická kúpeľňa s veľkoformátovým obkladom.",
  skillIds: [],
  solution: null,
  specializationIds: [],
  title: "Rekonštrukcia kúpeľne",
  updatedAt: now,
};

const photoSet = {
  craftsmanProfileId: profileId,
  photos: [
    {
      attachedAt: now,
      attachmentId,
      canonicalHeight: 900,
      canonicalWidth: 1_200,
      capturedAt: null,
      mediaAssetId,
      order: 1,
      phase: "AFTER" as const,
      state: "ACTIVE" as const,
    },
  ],
  portfolioProjectId: projectId,
  revision: 1,
  updatedAt: now,
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("craftsman portfolio routes", () => {
  it("lists only minimized private self-declared projects", async () => {
    const { app } = apiWith();
    const response = await app.inject({
      method: "GET",
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.projects),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      projects: [
        {
          evidenceStatus: "UNVERIFIED",
          id: projectId,
          provenanceKind: "SELF_DECLARED",
          recordState: "DRAFT",
        },
      ],
    });
    expect(response.body).not.toContain(actorUserId);
  });

  it("fails closed for anonymous, foreign and query-bearing requests", async () => {
    const anonymous = apiWith({
      guard: {
        evaluate: vi.fn(() =>
          Promise.resolve({ status: "AUTHENTICATION_REQUIRED" as const }),
        ),
      },
    });
    expect(
      (
        await anonymous.app.inject({
          method: "GET",
          url: path(CRAFTSMAN_PORTFOLIO_PATHS.projects),
        })
      ).statusCode,
    ).toBe(401);

    const { app, dependencies } = apiWith();
    expect(
      (
        await app.inject({
          method: "GET",
          url: path(CRAFTSMAN_PORTFOLIO_PATHS.projects, foreignProfileId),
        })
      ).statusCode,
    ).toBe(404);
    expect(dependencies.projects.listOwned).not.toHaveBeenCalledWith(
      expect.objectContaining({ craftsmanProfileId: foreignProfileId }),
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${path(CRAFTSMAN_PORTFOLIO_PATHS.projects)}?owner=true`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("creates and edits a minimal draft through the PUBLISHING scope", async () => {
    const { app, dependencies, csrf } = apiWith();
    const created = await app.inject({
      method: "POST",
      payload: createBody(),
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.projects),
    });
    expect(created.statusCode).toBe(201);
    expect(dependencies.guard.evaluate).toHaveBeenCalledWith(
      expect.anything(),
      "PUBLISHING",
    );
    expect(dependencies.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId,
        craftsmanProfileId: profileId,
        municipalityCode: null,
        portfolioProjectId: projectId,
        professionIds: [professionId],
        skillIds: [],
      }),
    );

    const edited = await app.inject({
      method: "PUT",
      payload: {
        ...createBody(),
        expectedRevision: 1,
      },
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.project),
    });
    expect(edited.statusCode).toBe(400);

    const validEdit = await app.inject({
      method: "PUT",
      payload: {
        commandId,
        contribution: null,
        expectedRevision: 1,
        professionIds: [professionId],
        shortDescription: "Upravený syntetický popis realizácie.",
        title: "Upravená kúpeľňa",
      },
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.project),
    });
    expect(validEdit.statusCode).toBe(200);
    expect(csrf).toHaveBeenCalledTimes(3);
  });

  it("rejects browser-injected fields and maps stale writes without leaking", async () => {
    const { app, dependencies } = apiWith();
    const injected = await app.inject({
      method: "POST",
      payload: { ...createBody(), authorUserId: actorUserId },
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.projects),
    });
    expect(injected.statusCode).toBe(400);

    dependencies.projects.edit.mockResolvedValueOnce({
      status: "STALE_REVISION",
    });
    const stale = await app.inject({
      method: "PUT",
      payload: {
        commandId,
        contribution: null,
        expectedRevision: 1,
        professionIds: [professionId],
        shortDescription: "Upravený syntetický popis realizácie.",
        title: "Upravená kúpeľňa",
      },
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.project),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ code: "STALE_REVISION" });
  });

  it("uploads only a guarded image with current project revision", async () => {
    const { app, dependencies } = apiWith();
    const missingRevision = await app.inject({
      headers: { "content-type": "image/png" },
      method: "POST",
      payload: Buffer.from([1, 2, 3]),
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.photoUploads),
    });
    expect(missingRevision.statusCode).toBe(400);

    const uploaded = await app.inject({
      headers: {
        "content-type": "image/png",
        "x-expected-project-revision": "1",
        "x-file-name": "synthetic.png",
      },
      method: "POST",
      payload: Buffer.from([1, 2, 3]),
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.photoUploads),
    });
    expect(uploaded.statusCode).toBe(202);
    expect(uploaded.json()).toEqual({
      assetId: mediaAssetId,
      kind: "IMAGE",
      status: "PROCESSING",
    });
    expect(dependencies.uploads.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        craftsmanProfileId: profileId,
        expectedProjectRevision: 1,
        portfolioProjectId: projectId,
      }),
    );
    expect(uploaded.body).not.toMatch(/storage|synthetic\.png/iu);
  });

  it("polls private status then attaches READY media with a phase", async () => {
    const { app, dependencies } = apiWith();
    const polled = await app.inject({
      method: "GET",
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.photoUploads),
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({
      uploads: [{ assetId: mediaAssetId, kind: "IMAGE", status: "READY" }],
    });

    const attached = await app.inject({
      method: "POST",
      payload: {
        attachmentId,
        commandId,
        expectedRevision: 0,
        mediaAssetId,
        phase: "AFTER",
      },
      url: path(CRAFTSMAN_PORTFOLIO_PATHS.photos),
    });
    expect(attached.statusCode).toBe(201);
    expect(dependencies.photos.attach).toHaveBeenCalledWith({
      actorUserId,
      attachmentId,
      commandId,
      craftsmanProfileId: profileId,
      expectedRevision: 0,
      mediaAssetId,
      phase: "AFTER",
      portfolioProjectId: projectId,
    });
    expect(attached.json()).toMatchObject({
      photoSet: {
        photos: [
          {
            downloadPath: `/v1/media/${mediaAssetId}/download`,
            mediaAssetId,
          },
        ],
      },
      status: "APPLIED",
    });
  });
});

function apiWith(overrides: Partial<CraftsmanPortfolioRouteDependencies> = {}) {
  const csrf = vi.fn((_request, _reply, done: () => void) => done());
  const dependencies = {
    context: { findOwnedProfileId: vi.fn(() => Promise.resolve(profileId)) },
    csrfProtection: csrf,
    guard: {
      evaluate: vi.fn(() =>
        Promise.resolve({
          status: "ACTIVE" as const,
          user: { id: actorUserId },
        }),
      ),
    },
    photos: {
      attach: vi.fn(() =>
        Promise.resolve({ photoSet, status: "APPLIED" as const }),
      ),
      hide: vi.fn(),
      listOwned: vi.fn(() => Promise.resolve(photoSet)),
      reorder: vi.fn(),
      restore: vi.fn(),
      setPhase: vi.fn(),
    },
    projects: {
      archive: vi.fn(),
      create: vi.fn(() =>
        Promise.resolve({ project, status: "APPLIED" as const }),
      ),
      edit: vi.fn(() =>
        Promise.resolve({ project, status: "APPLIED" as const }),
      ),
      hide: vi.fn(),
      listOwned: vi.fn(() => Promise.resolve([project])),
      restoreDraft: vi.fn(),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
    uploads: {
      list: vi.fn(() =>
        Promise.resolve({
          status: "OK" as const,
          uploads: [
            {
              assetId: mediaAssetId,
              kind: "IMAGE" as const,
              status: "READY" as const,
            },
          ],
        }),
      ),
      upload: vi.fn(() =>
        Promise.resolve({
          assetId: mediaAssetId,
          kind: "IMAGE" as const,
          status: "PROCESSING" as const,
        }),
      ),
    },
    ...overrides,
  } as unknown as CraftsmanPortfolioRouteDependencies & {
    readonly guard: { readonly evaluate: ReturnType<typeof vi.fn> };
    readonly photos: {
      readonly attach: ReturnType<typeof vi.fn>;
      readonly listOwned: ReturnType<typeof vi.fn>;
    };
    readonly projects: {
      readonly create: ReturnType<typeof vi.fn>;
      readonly edit: ReturnType<typeof vi.fn>;
      readonly listOwned: ReturnType<typeof vi.fn>;
    };
    readonly uploads: {
      readonly list: ReturnType<typeof vi.fn>;
      readonly upload: ReturnType<typeof vi.fn>;
    };
  };
  const app = Fastify();
  registerCraftsmanPortfolioRoutes(app, dependencies);
  apps.push(app);
  return { app, csrf, dependencies };
}

function createBody() {
  return {
    commandId,
    contribution: "Montáž a finálne škárovanie.",
    portfolioProjectId: projectId,
    professionIds: [professionId],
    shortDescription: "Syntetická kúpeľňa s veľkoformátovým obkladom.",
    title: "Rekonštrukcia kúpeľne",
  };
}

function path(template: string, selectedProfileId = profileId): string {
  return template
    .replace(":profileId", selectedProfileId)
    .replace(":projectId", projectId);
}
