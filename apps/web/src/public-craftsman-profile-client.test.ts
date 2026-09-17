import type { PublicCraftsmanProfile } from "@portal/domain";
import { describe, expect, it, vi } from "vitest";

import { createPublicCraftsmanProfileLoader } from "./public-craftsman-profile-client";

const profileId = "84000000-0000-4000-8000-000000000001";

describe("public craftsman profile client", () => {
  it("uses only the no-store public API and re-applies the allowlist", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...profile(),
            email: "owner@example.test",
            exactAddress: "Tajná 12",
            storageKey: "private/document",
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await createPublicCraftsmanProfileLoader({
      apiOrigin: "http://api:3001",
      fetch: fetcher,
    })(profileId);

    expect(fetcher).toHaveBeenCalledWith(
      new URL(`http://api:3001/v1/public/craftsmen/${profileId}`),
      { cache: "no-store", headers: { accept: "application/json" } },
    );
    expect(JSON.stringify(result)).not.toMatch(/owner@example|Tajná|storage/iu);
  });

  it("maps hidden and unavailable API responses to the same absence", async () => {
    for (const status of [404, 503]) {
      const load = createPublicCraftsmanProfileLoader({
        apiOrigin: "http://api:3001",
        fetch: () => Promise.resolve(new Response(null, { status })),
      });
      await expect(load(profileId)).resolves.toBeNull();
    }
  });

  it("fails closed for an invalid internal API origin", async () => {
    const fetcher = vi.fn();
    const load = createPublicCraftsmanProfileLoader({
      apiOrigin: "https://user:secret@example.test/private",
      fetch: fetcher,
    });
    await expect(load(profileId)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

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
    portfolio: [],
    skills: [],
    specializations: [],
    indicativePricing: [],
    experience: null,
    credentials: [],
  };
}
