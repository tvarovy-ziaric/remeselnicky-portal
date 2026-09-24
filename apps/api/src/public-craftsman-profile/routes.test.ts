import type {
  PublicCraftsmanProfile,
  PublicCraftsmanProfilePersistence,
  PortfolioProjectId,
} from "@portal/domain";
import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "../app.js";

const profileId = "83000000-0000-4000-8000-000000000001";
const openApps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("public craftsman profile route", () => {
  it("returns only the allowlisted profile and no-store metadata", async () => {
    const leaked = {
      ...profile(),
      email: "owner@example.test",
      exactHomeAddress: "Tajná 12",
      rawCompletenessPercent: 100,
      credentialEvidence: { storageKey: "private/key", sha256: "a".repeat(64) },
      portfolio: profile().portfolio.map((project) => ({
        ...project,
        customerName: "Neverejný zákazník",
        exactAddress: "Tajná 12",
        photos: project.photos.map((photo) => ({
          ...photo,
          storageKey: "private/photo.webp",
          sha256: "b".repeat(64),
        })),
      })),
    } as unknown as PublicCraftsmanProfile;
    const app = apiWith(repository(leaked));
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("index, follow");
    expect(response.json()).toMatchObject({
      identity: { primaryName: "Majster Jano" },
      portfolio: [{ projectId: "83000000-0000-4000-8000-000000000002" }],
    });
    expect(response.body).not.toMatch(
      /owner@example|Tajná|Neverejný|completeness|storageKey|sha256|private\/key/iu,
    );
  });

  it.each(["hidden", "suspended", "rejected", "unknown"])(
    "uses the same 404 response for a %s profile",
    async () => {
      const app = apiWith(repository(null));
      const response = await app.inject({
        method: "GET",
        url: `/v1/public/craftsmen/${profileId}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "NOT_FOUND" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    },
  );

  it("does not leak persistence errors", async () => {
    const app = apiWith({
      findPublic: () =>
        Promise.reject(
          new Error("postgresql://owner:secret@db/private_storage_key"),
        ),
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/public/craftsmen/${profileId}`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toMatch(/secret|storage|postgres/iu);
  });
});

function apiWith(profiles: PublicCraftsmanProfilePersistence) {
  const app = buildApi({
    database: { ping: () => Promise.resolve() },
    publicCraftsmanProfiles: { profiles },
  });
  openApps.push(app);
  return app;
}

function repository(
  value: PublicCraftsmanProfile | null,
): PublicCraftsmanProfilePersistence {
  return { findPublic: () => Promise.resolve(value) };
}

function profile(): PublicCraftsmanProfile {
  return {
    profileId: profileId as PublicCraftsmanProfile["profileId"],
    identity: {
      profileType: "INDIVIDUAL",
      primaryName: "Majster Jano",
      secondaryName: "Ján Remeselný",
      about: "Poctivé stolárske práce.",
    },
    professions: [
      {
        code: "PROF:CARPENTER",
        label: "Stolár",
        customerScore: null,
        reviewCount: 0,
        verifiedJobCount: 0,
        declaredProficiency: { level: "MASTER", source: "SELF_DECLARED" },
        evidenceSupportedProficiency: null,
      },
    ],
    location: {
      baseMunicipality: { code: "SK0101528595", name: "Bratislava" },
      normalRadiusMeters: 25_000,
      extraMunicipalities: [],
    },
    trust: {
      identityVerified: true,
      companyRegistrationVerified: false,
      customerScore: null,
      reviewCount: 0,
      verifiedWorkCount: 0,
    },
    callToAction: { kind: "PLATFORM_JOB_REQUEST" },
    portfolio: [
      {
        projectId: "83000000-0000-4000-8000-000000000002" as PortfolioProjectId,
        title: "Dubová knižnica",
        shortDescription: "Výroba knižnice na mieru.",
        provenance: {
          kind: "SELF_DECLARED",
          evidenceStatus: "UNVERIFIED",
        },
        contribution: null,
        materialsAndTechnologies: "Masívny dub",
        problem: null,
        solution: null,
        duration: { value: 2, unit: "WEEKS" },
        indicativePrice: {
          currency: "EUR",
          minCents: 120_000,
          maxCents: 150_000,
        },
        approximateLocation: {
          municipalityCode: "SK0101528595",
          districtCode: "SK0101",
        },
        professions: [{ code: "PROF:CARPENTER", label: "Stolár" }],
        skills: [],
        specializations: [],
        photos: [
          {
            mediaAssetId: "83000000-0000-4000-8000-000000000003",
            phase: "AFTER",
            displayOrder: 1,
            width: 1200,
            height: 900,
          },
        ],
      },
    ],
    skills: [],
    specializations: [],
    indicativePricing: [],
    experience: null,
    credentials: [],
  };
}
