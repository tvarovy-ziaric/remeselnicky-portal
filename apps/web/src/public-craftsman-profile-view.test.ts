import type { PublicCraftsmanProfile } from "@portal/domain";
import { describe, expect, it } from "vitest";

import {
  formatEurCents,
  priceModeLabel,
  publicProfileMetadata,
} from "./public-craftsman-profile-view";

describe("public craftsman profile view", () => {
  it("indexes only an available public projection", () => {
    expect(publicProfileMetadata(profile()).robots).toEqual({
      follow: true,
      index: true,
    });
    expect(publicProfileMetadata(null).robots).toEqual({
      follow: false,
      index: false,
      nocache: true,
    });
  });

  it("formats exact EUR cents and locked price modes", () => {
    expect(formatEurCents(12_345)).toContain("123,45");
    expect(priceModeLabel("PER_SQUARE_METER")).toBe("za m²");
  });
});

function profile(): PublicCraftsmanProfile {
  return {
    profileId:
      "84000000-0000-4000-8000-000000000001" as PublicCraftsmanProfile["profileId"],
    identity: {
      profileType: "COMPANY",
      primaryName: "Poctivé remeslo",
      secondaryName: null,
      about: "Poctivé remeselné práce.",
    },
    professions: [],
    location: {
      baseMunicipality: { code: "SK", name: "Bratislava" },
      normalRadiusMeters: 10_000,
      extraMunicipalities: [],
    },
    trust: {
      identityVerified: true,
      companyRegistrationVerified: true,
      customerScore: null,
      reviewCount: 0,
      verifiedWorkCount: 0,
    },
    callToAction: { kind: "PLATFORM_JOB_REQUEST" },
    portfolio: [],
    skills: [],
    specializations: [],
    indicativePricing: [],
    experience: null,
    credentials: [],
  };
}
