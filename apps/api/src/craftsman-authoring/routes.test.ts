import type {
  CraftsmanProfileId,
  CraftsmanProfessionId,
  CraftsmanServiceId,
  UserId,
} from "@portal/domain";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- assertions target Vitest spies stored on dependency objects */

import {
  CRAFTSMAN_AUTHORING_PATHS,
  registerCraftsmanAuthoringRoutes,
  type CraftsmanAuthoringRouteDependencies,
} from "./routes.js";

const actorUserId = "9d330000-0000-4000-8000-000000000001" as UserId;
const profileId = "9d330000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const foreignProfileId =
  "9d330000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const professionId =
  "9d330000-0000-4000-8000-000000000004" as CraftsmanProfessionId;
const serviceId = "9d330000-0000-4000-8000-000000000008" as CraftsmanServiceId;
const commandId = "9d330000-0000-4000-8000-000000000005";
const taxonomyReleaseId = "9d330000-0000-4000-8000-000000000006";
const now = new Date("2026-09-28T12:00:00.000Z");

const individualProfile = {
  about: "Poctivá syntetická práca.",
  createdAt: now,
  id: profileId,
  identityVerification: {
    reference: "private:identity/reference",
    verifiedAt: now,
  },
  nickname: "Majster",
  ownerUserId: actorUserId,
  profileType: "INDIVIDUAL" as const,
  realFirstName: "Ján",
  realLastName: "Remeselník",
  revision: 2,
  updatedAt: now,
};

const profession = {
  createdAt: now,
  craftsmanProfileId: profileId,
  declaredLevel: "ADVANCED" as const,
  declaredLevelChangedAt: now,
  declaredLevelRevision: 1,
  deactivatedAt: null,
  evidenceSupportedAt: null,
  evidenceSupportedLevel: null,
  id: professionId,
  professionCode: "PROF:TILER",
  state: "ACTIVE" as const,
  taxonomyReleaseId,
};

const craftsmanService = {
  craftsmanProfessionIds: [professionId],
  craftsmanProfileId: profileId,
  createdAt: now,
  deactivatedAt: null,
  id: serviceId,
  serviceCode: "SERV:TILE_INSTALLATION",
  state: "ACTIVE" as const,
  taxonomyReleaseId,
};

const serviceArea = {
  baseMunicipalityCode: "SK:BA:BA" as never,
  craftsmanProfileId: profileId,
  createdAt: now,
  extraMunicipalityCodes: [],
  id: "9d330000-0000-4000-8000-000000000007" as never,
  maximumRadiusKm: null,
  normalRadiusKm: 25,
  revision: 1,
  travelFeePolicy: null,
  travelFeeThresholdKm: null,
};

const publication = {
  approved: null,
  changedAt: now,
  craftsmanProfileId: profileId,
  effectivelyPublic: false,
  moderation: null,
  moderationState: "ALLOWED" as const,
  ownerVisibility: "HIDDEN" as const,
  readiness: { isReady: true, missing: [] },
  rejection: null,
  reviewState: "DRAFT" as const,
  revision: 0,
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("craftsman authoring routes", () => {
  it("returns one minimized owner aggregate with private cache boundaries", async () => {
    const { app } = apiWith();
    const response = await app.inject({
      method: "GET",
      url: CRAFTSMAN_AUTHORING_PATHS.profile,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.json()).toMatchObject({
      profile: {
        id: profileId,
        identityVerified: true,
        profileType: "INDIVIDUAL",
        realFirstName: "Ján",
        revision: 2,
      },
      professions: [
        {
          declaredLevel: "ADVANCED",
          id: professionId,
          professionCode: "PROF:TILER",
        },
      ],
      services: [
        {
          craftsmanProfessionIds: [professionId],
          id: serviceId,
          serviceCode: "SERV:TILE_INSTALLATION",
        },
      ],
      publication: { readiness: { isReady: true }, revision: 0 },
      serviceArea: { normalRadiusKm: 25, revision: 1 },
    });
    expect(response.body).not.toContain(actorUserId);
    expect(response.body).not.toContain("private:identity/reference");
    expect(response.body).not.toContain(taxonomyReleaseId);
  });

  it("fails closed for anonymous/inactive actors, unknown queries and foreign profiles", async () => {
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
          url: CRAFTSMAN_AUTHORING_PATHS.profile,
        })
      ).statusCode,
    ).toBe(401);

    const inactive = apiWith({
      guard: {
        evaluate: vi.fn(() =>
          Promise.resolve({ status: "ACCOUNT_NOT_ACTIVE" as const }),
        ),
      },
    });
    expect(
      (
        await inactive.app.inject({
          method: "POST",
          payload: validCreateBody(),
          url: CRAFTSMAN_AUTHORING_PATHS.profile,
        })
      ).statusCode,
    ).toBe(403);

    const { app, dependencies } = apiWith();
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${CRAFTSMAN_AUTHORING_PATHS.profile}?private=true`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/me/craftsman-profile/${foreignProfileId}/publication`,
        })
      ).statusCode,
    ).toBe(404);
    expect(dependencies.publication.findOwned).not.toHaveBeenCalledWith(
      expect.objectContaining({ craftsmanProfileId: foreignProfileId }),
    );
  });

  it("creates and replaces a profile for the server-derived PUBLISHING actor", async () => {
    const { app, dependencies, csrf } = apiWith();
    const created = await app.inject({
      method: "POST",
      payload: validCreateBody(),
      url: CRAFTSMAN_AUTHORING_PATHS.profile,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ profile: { id: profileId } });
    expect(dependencies.profiles.createPrivateDraft).toHaveBeenCalledWith({
      ...validCreateBody(),
      actorUserId,
    });
    expect(dependencies.guard.evaluate).toHaveBeenCalledWith(
      expect.anything(),
      "PUBLISHING",
    );

    const replaced = await app.inject({
      method: "PUT",
      payload: {
        ...validCreateBody(),
        about: "Nový bezpečný popis.",
        expectedRevision: 2,
        nickname: "Majster",
        realFirstName: "Ján",
        realLastName: "Remeselník",
      },
      url: `/v1/me/craftsman-profile/${profileId}`,
    });
    expect(replaced.statusCode).toBe(200);
    expect(dependencies.profiles.replacePrivateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId, profileId }),
    );
    expect(csrf).toHaveBeenCalledTimes(2);

    const invalid = await app.inject({
      method: "POST",
      payload: { ...validCreateBody(), ownerUserId: actorUserId },
      url: CRAFTSMAN_AUTHORING_PATHS.profile,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("assigns the current governed profession without trusting a browser release", async () => {
    const { app, dependencies } = apiWith();
    const assigned = await app.inject({
      method: "POST",
      payload: {
        commandId,
        craftsmanProfessionId: professionId,
        declaredLevel: "ADVANCED",
        professionCode: "PROF:TILER",
      },
      url: `/v1/me/craftsman-profile/${profileId}/professions`,
    });
    expect(assigned.statusCode).toBe(201);
    expect(dependencies.context.resolveCurrentProfession).toHaveBeenCalledWith(
      "PROF:TILER",
    );
    expect(dependencies.professions.assign).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profileId,
      declaredLevel: "ADVANCED",
      professionCode: "PROF:TILER",
      taxonomyReleaseId,
    });

    const injectedRelease = await app.inject({
      method: "POST",
      payload: {
        commandId,
        craftsmanProfessionId: professionId,
        declaredLevel: "ADVANCED",
        professionCode: "PROF:TILER",
        taxonomyReleaseId,
      },
      url: `/v1/me/craftsman-profile/${profileId}/professions`,
    });
    expect(injectedRelease.statusCode).toBe(400);
  });

  it("supports level/deactivation commands and maps stale or unavailable targets safely", async () => {
    const { app, dependencies } = apiWith();
    expect(
      (
        await app.inject({
          method: "POST",
          payload: {
            commandId,
            declaredLevel: "MASTER",
            expectedDeclaredLevelRevision: 1,
          },
          url: `/v1/me/craftsman-profile/${profileId}/professions/${professionId}/level`,
        })
      ).statusCode,
    ).toBe(200);
    expect(dependencies.professions.changeDeclaredLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId,
        craftsmanProfessionId: professionId,
      }),
    );

    vi.mocked(dependencies.professions.deactivate).mockResolvedValueOnce({
      status: "ASSIGNMENT_NOT_ACTIVE",
    });
    const inactive = await app.inject({
      method: "POST",
      payload: { commandId },
      url: `/v1/me/craftsman-profile/${profileId}/professions/${professionId}/deactivate`,
    });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json()).toEqual({ code: "ASSIGNMENT_NOT_ACTIVE" });
  });

  it("adds and deactivates only a governed service owned by the profile", async () => {
    const { app, dependencies } = apiWith();
    const added = await app.inject({
      method: "POST",
      payload: {
        commandId,
        craftsmanProfessionIds: [professionId],
        craftsmanServiceId: serviceId,
        serviceCode: "SERV:TILE_INSTALLATION",
      },
      url: `/v1/me/craftsman-profile/${profileId}/services`,
    });
    expect(added.statusCode).toBe(201);
    expect(dependencies.context.resolveCurrentService).toHaveBeenCalledWith(
      "SERV:TILE_INSTALLATION",
    );
    expect(dependencies.services.add).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfessionIds: [professionId],
      craftsmanProfileId: profileId,
      craftsmanServiceId: serviceId,
      serviceCode: "SERV:TILE_INSTALLATION",
      taxonomyReleaseId,
    });

    const deactivated = await app.inject({
      method: "POST",
      payload: { commandId },
      url: `/v1/me/craftsman-profile/${profileId}/services/${serviceId}/deactivate`,
    });
    expect(deactivated.statusCode).toBe(200);
    expect(dependencies.services.deactivate).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfileId: profileId,
      craftsmanServiceId: serviceId,
    });

    const injectedRelease = await app.inject({
      method: "POST",
      payload: {
        commandId,
        craftsmanProfessionIds: [professionId],
        craftsmanServiceId: serviceId,
        serviceCode: "SERV:TILE_INSTALLATION",
        taxonomyReleaseId,
      },
      url: `/v1/me/craftsman-profile/${profileId}/services`,
    });
    expect(injectedRelease.statusCode).toBe(400);
  });

  it("replaces the service area and preserves server ownership and revisions", async () => {
    const { app, dependencies } = apiWith();
    const payload = {
      baseMunicipalityCode: "SK:BA:BA",
      commandId,
      expectedRevision: 0,
      extraMunicipalityCodes: [],
      maximumRadiusKm: null,
      normalRadiusKm: 25,
      travelFeePolicy: null,
      travelFeeThresholdKm: null,
    };
    const response = await app.inject({
      method: "PUT",
      payload,
      url: `/v1/me/craftsman-profile/${profileId}/service-area`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      serviceArea: { baseMunicipalityCode: "SK:BA:BA", normalRadiusKm: 25 },
      status: "APPLIED",
    });
    expect(dependencies.serviceAreas.replaceOwnedDraft).toHaveBeenCalledWith({
      ...payload,
      actorUserId,
      craftsmanProfileId: profileId,
    });

    const tooMany = await app.inject({
      method: "PUT",
      payload: {
        ...payload,
        extraMunicipalityCodes: ["A", "B", "C", "D"],
      },
      url: `/v1/me/craftsman-profile/${profileId}/service-area`,
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("submits a ready profile, returns readiness failures, and changes visibility", async () => {
    const { app, dependencies } = apiWith();
    const submitted = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 0 },
      url: `/v1/me/craftsman-profile/${profileId}/publication/submit`,
    });
    expect(submitted.statusCode).toBe(200);
    expect(dependencies.publication.submitForReview).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfileId: profileId,
      expectedRevision: 0,
    });

    vi.mocked(dependencies.publication.submitForReview).mockResolvedValueOnce({
      readiness: { isReady: false, missing: ["ABOUT"] },
      status: "NOT_READY",
    });
    const notReady = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 0 },
      url: `/v1/me/craftsman-profile/${profileId}/publication/submit`,
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toEqual({
      code: "NOT_READY",
      readiness: { isReady: false, missing: ["ABOUT"] },
    });

    const visibility = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 0, visibility: "PUBLIC" },
      url: `/v1/me/craftsman-profile/${profileId}/publication/visibility`,
    });
    expect(visibility.statusCode).toBe(200);
    expect(dependencies.publication.setOwnerVisibility).toHaveBeenCalledWith({
      actorUserId,
      commandId,
      craftsmanProfileId: profileId,
      expectedRevision: 0,
      visibility: "PUBLIC",
    });
  });

  it("maps idempotency conflicts and redacts unexpected persistence errors", async () => {
    const idempotency = Object.assign(new Error("private payload"), {
      code: "CRAFTSMAN_PROFESSION_IDEMPOTENCY_CONFLICT",
    });
    const first = apiWith();
    vi.mocked(first.dependencies.professions.assign).mockRejectedValueOnce(
      idempotency,
    );
    const conflictResponse = await first.app.inject({
      method: "POST",
      payload: {
        commandId,
        craftsmanProfessionId: professionId,
        declaredLevel: "ADVANCED",
        professionCode: "PROF:TILER",
      },
      url: `/v1/me/craftsman-profile/${profileId}/professions`,
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.body).not.toContain("private payload");

    const second = apiWith();
    vi.mocked(second.dependencies.serviceAreas.findOwned).mockRejectedValueOnce(
      new Error("private address"),
    );
    const unavailable = await second.app.inject({
      method: "GET",
      url: `/v1/me/craftsman-profile/${profileId}/service-area`,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).not.toContain("private address");
  });
});

function validCreateBody() {
  return {
    about: "Poctivá syntetická práca.",
    nickname: "Majster",
    profileType: "INDIVIDUAL" as const,
    realFirstName: "Ján",
    realLastName: "Remeselník",
  };
}

function apiWith(overrides: Partial<CraftsmanAuthoringRouteDependencies> = {}) {
  const csrf = vi.fn((_request, _reply, done: () => void) => done());
  const dependencies = {
    context: {
      findOwnedProfileId: vi.fn(() => Promise.resolve(profileId)),
      resolveCurrentProfession: vi.fn(() =>
        Promise.resolve({
          professionCode: "PROF:TILER",
          taxonomyReleaseId,
        }),
      ),
      resolveCurrentService: vi.fn(() =>
        Promise.resolve({
          professionCodes: ["PROF:TILER"],
          serviceCode: "SERV:TILE_INSTALLATION",
          taxonomyReleaseId,
        }),
      ),
    },
    csrfProtection: csrf,
    guard: {
      evaluate: vi.fn(() =>
        Promise.resolve({
          status: "ACTIVE" as const,
          user: { id: actorUserId },
        }),
      ),
    },
    profiles: {
      createPrivateDraft: vi.fn(() =>
        Promise.resolve({
          profile: individualProfile,
          status: "CREATED" as const,
        }),
      ),
      findOwnedPrivateDraft: vi.fn(() => Promise.resolve(individualProfile)),
      replacePrivateDraft: vi.fn(() =>
        Promise.resolve({
          profile: individualProfile,
          status: "UPDATED" as const,
        }),
      ),
    },
    professions: {
      assign: vi.fn(() =>
        Promise.resolve({ profession, status: "APPLIED" as const }),
      ),
      changeDeclaredLevel: vi.fn(() =>
        Promise.resolve({
          profession: { ...profession, declaredLevel: "MASTER" as const },
          status: "APPLIED" as const,
        }),
      ),
      deactivate: vi.fn(() =>
        Promise.resolve({
          profession: {
            ...profession,
            deactivatedAt: now,
            state: "INACTIVE" as const,
          },
          status: "APPLIED" as const,
        }),
      ),
      listOwned: vi.fn(() => Promise.resolve([profession])),
    },
    services: {
      add: vi.fn(() =>
        Promise.resolve({
          service: craftsmanService,
          status: "APPLIED" as const,
        }),
      ),
      deactivate: vi.fn(() =>
        Promise.resolve({
          service: {
            ...craftsmanService,
            deactivatedAt: now,
            state: "INACTIVE" as const,
          },
          status: "APPLIED" as const,
        }),
      ),
      listOwned: vi.fn(() => Promise.resolve([craftsmanService])),
    },
    publication: {
      approve: vi.fn(),
      findOwned: vi.fn(() => Promise.resolve(publication)),
      reject: vi.fn(),
      requireIdentityReview: vi.fn(),
      restoreModeration: vi.fn(),
      setModeration: vi.fn(),
      setOwnerVisibility: vi.fn(() =>
        Promise.resolve({
          publication: { ...publication, ownerVisibility: "PUBLIC" as const },
          status: "APPLIED" as const,
        }),
      ),
      submitForReview: vi.fn(() =>
        Promise.resolve({
          publication: { ...publication, reviewState: "PENDING" as const },
          status: "APPLIED" as const,
        }),
      ),
    },
    rateLimit: { max: 20, timeWindowMs: 60_000 },
    serviceAreas: {
      findOwned: vi.fn(() => Promise.resolve(serviceArea)),
      replaceOwnedDraft: vi.fn(() =>
        Promise.resolve({
          serviceArea,
          status: "APPLIED" as const,
        }),
      ),
    },
    ...overrides,
  } as unknown as CraftsmanAuthoringRouteDependencies & {
    readonly context: {
      readonly findOwnedProfileId: ReturnType<typeof vi.fn>;
      readonly resolveCurrentProfession: ReturnType<typeof vi.fn>;
      readonly resolveCurrentService: ReturnType<typeof vi.fn>;
    };
    readonly guard: { readonly evaluate: ReturnType<typeof vi.fn> };
    readonly profiles: {
      readonly createPrivateDraft: ReturnType<typeof vi.fn>;
      readonly findOwnedPrivateDraft: ReturnType<typeof vi.fn>;
      readonly replacePrivateDraft: ReturnType<typeof vi.fn>;
    };
    readonly professions: {
      readonly assign: ReturnType<typeof vi.fn>;
      readonly changeDeclaredLevel: ReturnType<typeof vi.fn>;
      readonly deactivate: ReturnType<typeof vi.fn>;
      readonly listOwned: ReturnType<typeof vi.fn>;
    };
    readonly services: {
      readonly add: ReturnType<typeof vi.fn>;
      readonly deactivate: ReturnType<typeof vi.fn>;
      readonly listOwned: ReturnType<typeof vi.fn>;
    };
    readonly publication: {
      readonly findOwned: ReturnType<typeof vi.fn>;
      readonly setOwnerVisibility: ReturnType<typeof vi.fn>;
      readonly submitForReview: ReturnType<typeof vi.fn>;
    };
    readonly serviceAreas: {
      readonly findOwned: ReturnType<typeof vi.fn>;
      readonly replaceOwnedDraft: ReturnType<typeof vi.fn>;
    };
  };
  const app = Fastify();
  registerCraftsmanAuthoringRoutes(app, dependencies);
  apps.push(app);
  return { app, csrf, dependencies };
}
