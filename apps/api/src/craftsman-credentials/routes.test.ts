import type {
  CredentialClaimId,
  CraftsmanProfessionId,
  CraftsmanProfileId,
  UserId,
} from "@portal/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- assertions target Vitest spies */

import {
  CRAFTSMAN_CREDENTIAL_PATHS,
  registerCraftsmanCredentialRoutes,
  type CraftsmanCredentialRouteDependencies,
} from "./routes.js";

const actorUserId = "94300000-0000-4000-8000-000000000001" as UserId;
const profileId = "94300000-0000-4000-8000-000000000002" as CraftsmanProfileId;
const foreignProfileId =
  "94300000-0000-4000-8000-000000000003" as CraftsmanProfileId;
const professionId =
  "94300000-0000-4000-8000-000000000004" as CraftsmanProfessionId;
const claimId = "94300000-0000-4000-8000-000000000005" as CredentialClaimId;
const commandId = "94300000-0000-4000-8000-000000000006";
const mediaAssetId = "94300000-0000-4000-8000-000000000007";
const now = new Date("2026-09-28T12:00:00.000Z");

const claim = {
  id: claimId,
  craftsmanProfileId: profileId,
  craftsmanProfessionId: professionId,
  credentialTypeCode: "test.required-license",
  evidenceRequirement: "REQUIRED" as const,
  expiresOn: null,
  state: "PENDING" as const,
  revision: 1,
  evidence: [],
  reviewReasonCategory: null,
  reviewReason: null,
  reviewedAt: null,
  createdAt: now,
  updatedAt: now,
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("craftsman credential routes", () => {
  it("lists governed types and private owner claims without evidence bytes", async () => {
    const { app } = apiWith();
    const types = await app.inject({
      method: "GET",
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.credentialTypes),
    });
    const claims = await app.inject({
      method: "GET",
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.credentials),
    });

    expect(types.statusCode).toBe(200);
    expect(types.json()).toEqual({
      credentialTypes: [
        {
          code: "test.required-license",
          evidenceRequirement: "REQUIRED",
        },
      ],
    });
    expect(claims.statusCode).toBe(200);
    expect(claims.headers["cache-control"]).toBe("no-store");
    expect(claims.json()).toMatchObject({
      credentials: [
        {
          id: claimId,
          state: "PENDING",
          evidence: [],
          reviewReason: null,
        },
      ],
    });
    expect(claims.body).not.toMatch(/storage|filename|reviewedBy|download/iu);
  });

  it("fails closed for anonymous, foreign and query-bearing reads", async () => {
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
          url: path(CRAFTSMAN_CREDENTIAL_PATHS.credentials),
        })
      ).statusCode,
    ).toBe(401);

    const { app, dependencies } = apiWith();
    expect(
      (
        await app.inject({
          method: "GET",
          url: path(CRAFTSMAN_CREDENTIAL_PATHS.credentials, foreignProfileId),
        })
      ).statusCode,
    ).toBe(404);
    expect(dependencies.claims.listOwned).not.toHaveBeenCalledWith(
      expect.objectContaining({ craftsmanProfileId: foreignProfileId }),
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${path(CRAFTSMAN_CREDENTIAL_PATHS.credentials)}?all=true`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("creates only an owner PENDING claim through PUBLISHING scope", async () => {
    const { app, dependencies } = apiWith();
    const response = await app.inject({
      method: "POST",
      payload: createBody(),
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.credentials),
    });

    expect(response.statusCode).toBe(201);
    expect(dependencies.guard.evaluate).toHaveBeenCalledWith(
      expect.anything(),
      "PUBLISHING",
    );
    expect(dependencies.claims.create).toHaveBeenCalledWith({
      actorUserId,
      claimId,
      commandId,
      craftsmanProfessionId: professionId,
      craftsmanProfileId: profileId,
      credentialTypeCode: "test.required-license",
      expiresOn: null,
    });
    expect(response.json()).toMatchObject({
      claim: { state: "PENDING" },
      status: "APPLIED",
    });

    const injected = await app.inject({
      method: "POST",
      payload: { ...createBody(), state: "APPROVED" },
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.credentials),
    });
    expect(injected.statusCode).toBe(400);
  });

  it.each([
    ["documents", "application/pdf", "DOCUMENT"],
    ["photos", "image/png", "IMAGE"],
  ] as const)(
    "uploads guarded %s bytes with current claim revision",
    async (mediaKind, contentType, domainKind) => {
      const { app, dependencies } = apiWith();
      const response = await app.inject({
        headers: {
          "content-type": contentType,
          "x-expected-credential-revision": "1",
        },
        method: "POST",
        payload: Buffer.from([1, 2, 3]),
        url: path(CRAFTSMAN_CREDENTIAL_PATHS.evidenceUpload).replace(
          ":mediaKind",
          mediaKind,
        ),
      });

      expect(response.statusCode).toBe(202);
      expect(dependencies.uploads.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          claimId,
          craftsmanProfileId: profileId,
          expectedRevision: 1,
          mediaKind: domainKind,
        }),
      );
      expect(response.body).not.toMatch(/storage|filename/iu);
    },
  );

  it("polls status and attaches only repository-authorized evidence", async () => {
    const { app, dependencies } = apiWith();
    const polled = await app.inject({
      method: "GET",
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.evidenceUploads),
    });
    expect(polled.json()).toEqual({
      uploads: [{ assetId: mediaAssetId, kind: "DOCUMENT", status: "READY" }],
    });

    const attached = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 1, mediaAssetId },
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.evidence),
    });
    expect(attached.statusCode).toBe(201);
    expect(dependencies.claims.attachEvidence).toHaveBeenCalledWith({
      actorUserId,
      claimId,
      commandId,
      craftsmanProfileId: profileId,
      expectedRevision: 1,
      mediaAssetId,
    });

    dependencies.claims.attachEvidence.mockResolvedValueOnce({
      status: "STALE_REVISION",
    });
    const stale = await app.inject({
      method: "POST",
      payload: { commandId, expectedRevision: 1, mediaAssetId },
      url: path(CRAFTSMAN_CREDENTIAL_PATHS.evidence),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ code: "STALE_REVISION" });
  });
});

function apiWith(
  overrides: Partial<CraftsmanCredentialRouteDependencies> = {},
) {
  const csrf = vi.fn((_request, _reply, done: () => void) => done());
  const dependencies = {
    claims: {
      attachEvidence: vi.fn(() =>
        Promise.resolve({ claim, status: "APPLIED" as const }),
      ),
      create: vi.fn(() =>
        Promise.resolve({ claim, status: "APPLIED" as const }),
      ),
      listOwned: vi.fn(() => Promise.resolve([claim])),
    },
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
    rateLimit: { max: 20, timeWindowMs: 60_000 },
    types: {
      listActive: vi.fn(() =>
        Promise.resolve([
          {
            code: "test.required-license",
            evidenceRequirement: "REQUIRED" as const,
          },
        ]),
      ),
    },
    uploads: {
      list: vi.fn(() =>
        Promise.resolve({
          status: "OK" as const,
          uploads: [
            {
              assetId: mediaAssetId,
              kind: "DOCUMENT" as const,
              status: "READY" as const,
            },
          ],
        }),
      ),
      upload: vi.fn((input: { readonly mediaKind: "DOCUMENT" | "IMAGE" }) =>
        Promise.resolve({
          assetId: mediaAssetId,
          kind: input.mediaKind,
          status: "PROCESSING" as const,
        }),
      ),
    },
    ...overrides,
  } as unknown as CraftsmanCredentialRouteDependencies & {
    readonly claims: {
      readonly attachEvidence: ReturnType<typeof vi.fn>;
      readonly create: ReturnType<typeof vi.fn>;
      readonly listOwned: ReturnType<typeof vi.fn>;
    };
    readonly guard: { readonly evaluate: ReturnType<typeof vi.fn> };
    readonly uploads: {
      readonly list: ReturnType<typeof vi.fn>;
      readonly upload: ReturnType<typeof vi.fn>;
    };
  };
  const app = Fastify();
  registerCraftsmanCredentialRoutes(app, dependencies);
  apps.push(app);
  return { app, csrf, dependencies };
}

function createBody() {
  return {
    claimId,
    commandId,
    craftsmanProfessionId: professionId,
    credentialTypeCode: "test.required-license",
    expiresOn: null,
  };
}

function path(template: string, selectedProfileId = profileId): string {
  return template
    .replace(":profileId", selectedProfileId)
    .replace(":claimId", claimId);
}
