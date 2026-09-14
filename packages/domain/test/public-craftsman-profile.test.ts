import type { CraftsmanProfileId, PortfolioProjectId } from "../src/index.js";
import { describe, expect, it } from "vitest";

import {
  isPublicCraftsmanProfileId,
  PUBLIC_CRAFTSMAN_PROFILE_FIELDS,
  serializePublicCraftsmanProfile,
  type PublicCraftsmanProfileCandidate,
  type PublicPortfolioProject,
} from "../src/public-craftsman-profile.js";

const profileId = "81000000-0000-4000-8000-000000000001" as CraftsmanProfileId;

describe("public craftsman profile", () => {
  it("copies the explicit allowlist and discards private or internal extras", () => {
    const candidate = {
      ...validCandidate(),
      email: "owner@example.test",
      phone: "+421900000000",
      exactAddress: "Tajná 12",
      rawCompletenessPercent: 100,
      riskScore: 99,
      identityVerificationReference: "secret:identity",
      credentialEvidence: {
        sha256: "a".repeat(64),
        storageKey: "private/document.pdf",
      },
      identity: {
        ...validCandidate().identity,
        companyRegistrationNumber: "12345678",
        homeAddress: "Tajná 12",
      },
      credentials: [
        {
          ...validCandidate().credentials[0],
          reviewerUserId: "81000000-0000-4000-8000-000000000099",
          evidenceStorageKey: "private/document.pdf",
          reviewReason: "internal",
        },
      ],
      portfolio: [
        {
          ...validPortfolioProject(),
          exactAddress: "Tajná 12",
          customerName: "Neverejný zákazník",
          photos: [
            {
              ...validPortfolioProject().photos[0]!,
              storageKey: "private/photo.webp",
              sha256: "b".repeat(64),
              publicUrl: "https://internal.example.test/photo",
            },
          ],
        },
      ],
    } as unknown as PublicCraftsmanProfileCandidate;

    const serialized = serializePublicCraftsmanProfile(candidate);
    expect(Object.keys(serialized ?? {})).toEqual(
      PUBLIC_CRAFTSMAN_PROFILE_FIELDS,
    );
    expect(JSON.stringify(serialized)).not.toMatch(
      /owner@example|421900|Tajná|Neverejný|12345678|completeness|risk|storage|sha256|publicUrl|reviewer|reason|secret:identity/iu,
    );
  });

  it.each([
    "Napíšte na majster@example.sk",
    "Volajte +421 900 123 456",
    "Viac na https://example.sk",
    "Profil www.example.sk",
    "Nájdete ma: Ulica remeselná 12",
    "Prístupový api key abc",
  ])("fails closed for public contact/address/secret bypass: %s", (about) => {
    expect(
      serializePublicCraftsmanProfile({
        ...validCandidate(),
        identity: { ...validCandidate().identity, about },
      }),
    ).toBeNull();
  });

  it("allows legitimate numeric slash service descriptions", () => {
    expect(
      serializePublicCraftsmanProfile({
        ...validCandidate(),
        indicativePricing: [
          {
            ...validCandidate().indicativePricing[0]!,
            serviceName: "Montáž potrubia 1/2 a servis 230/400 V",
          },
        ],
      }),
    ).not.toBeNull();
  });

  it("fails closed for unsafe project text and malformed public photos", () => {
    expect(
      serializePublicCraftsmanProfile({
        ...validCandidate(),
        portfolio: [
          {
            ...validPortfolioProject(),
            problem: "Kontakt na zákazníka +421 900 123 456",
          },
        ],
      }),
    ).toBeNull();
    expect(
      serializePublicCraftsmanProfile({
        ...validCandidate(),
        portfolio: [
          {
            ...validPortfolioProject(),
            photos: [
              {
                ...validPortfolioProject().photos[0]!,
                displayOrder: 2,
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("validates opaque public profile identifiers", () => {
    expect(isPublicCraftsmanProfileId(profileId)).toBe(true);
    expect(isPublicCraftsmanProfileId("../private-profile")).toBe(false);
  });
});

function validCandidate(): PublicCraftsmanProfileCandidate {
  return {
    profileId,
    identity: {
      profileType: "INDIVIDUAL",
      primaryName: "Majster Jano",
      secondaryName: "Ján Remeselný",
      about: "Stolárske práce s dôrazom na poctivé remeslo.",
    },
    professions: [
      {
        code: "PROF:CARPENTER",
        label: "Stolár",
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
    portfolio: [validPortfolioProject()],
    skills: [
      {
        canonicalCode: "SKILL:FURNITURE",
        declared: { label: "Výroba nábytku", source: "SELF_DECLARED" },
        evidenceSupported: false,
        professionCodes: ["PROF:CARPENTER"],
      },
    ],
    specializations: [],
    indicativePricing: [
      {
        amountCents: 5_000,
        currency: "EUR",
        mode: "FROM",
        note: null,
        professionCode: "PROF:CARPENTER",
        serviceName: "Montáž nábytku",
      },
    ],
    experience: { source: "SELF_DECLARED", workingSinceYear: 2010 },
    credentials: [
      {
        credentialTypeCode: "trade.woodwork",
        expiresOn: null,
        professionCode: "PROF:CARPENTER",
        verification: "ADMIN_APPROVED",
      },
    ],
  };
}

function validPortfolioProject(): PublicPortfolioProject {
  return {
    projectId: "81000000-0000-4000-8000-000000000002" as PortfolioProjectId,
    title: "Dubová knižnica",
    shortDescription: "Výroba knižnice na mieru.",
    provenance: {
      kind: "SELF_DECLARED",
      evidenceStatus: "UNVERIFIED",
    },
    contribution: "Návrh a realizácia",
    materialsAndTechnologies: "Masívny dub",
    problem: "Nevyužitý priestor",
    solution: "Knižnica na celú výšku miestnosti",
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
    skills: [
      {
        canonicalCode: "SKILL:FURNITURE",
        label: "Výroba nábytku",
      },
    ],
    specializations: [],
    photos: [
      {
        mediaAssetId: "81000000-0000-4000-8000-000000000003",
        phase: "AFTER",
        displayOrder: 1,
        width: 1200,
        height: 900,
      },
    ],
  };
}
