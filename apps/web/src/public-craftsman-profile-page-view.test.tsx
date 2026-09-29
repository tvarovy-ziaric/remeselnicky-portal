import type { PublicCraftsmanProfile } from "@portal/domain";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicCraftsmanProfileView } from "./public-craftsman-profile-page-view";

describe("public craftsman profile page view", () => {
  it("renders the four user-facing profile sections and safe platform actions", () => {
    const html = renderToStaticMarkup(
      <PublicCraftsmanProfileView
        profile={profile()}
        reviews={{ nextCursor: null, reviews: [] }}
      />,
    );

    expect(html).toContain('id="main-content"');
    expect(html).toContain('href="#prehlad"');
    expect(html).toContain('href="#realizacie"');
    expect(html).toContain('href="#hodnotenia"');
    expect(html).toContain('href="#odbornost"');
    expect(html).toContain('href="/dopyt"');
    expect(html).toContain("Načítavam výber");
    expect(html).toContain("Overená identita");
    expect(html).toContain("4.8 z 5");
    expect(html).toContain("12");
    expect(html).toContain("3");

    expect(html).not.toContain("email@example.test");
    expect(html).not.toContain("+421");
    expect(html).not.toContain("Presná adresa");
  });

  it("renders portfolio photos image-first and marks every project as declared", () => {
    const html = renderToStaticMarkup(
      <PublicCraftsmanProfileView
        profile={profile()}
        reviews={{ nextCursor: null, reviews: [] }}
      />,
    );

    expect(html).toContain("portfolio-gallery");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="800"');
    expect(html).toContain(
      'src="/v1/public/media/84000000-0000-4000-8000-000000000003"',
    );
    expect(html).toContain("Uvádza remeselník");
    expect(html).not.toContain("Overená realizácia");
    expect(html).not.toContain("SELF_DECLARED");
    expect(html).not.toContain("UNVERIFIED");
    expect(html).not.toContain("BEFORE");
    expect(html).not.toContain("SK-BL");
    expect(html).not.toContain("BA1");
  });

  it("uses human labels without exposing credential, proficiency or price codes", () => {
    const html = renderToStaticMarkup(
      <PublicCraftsmanProfileView
        profile={profile()}
        reviews={{ nextCursor: null, reviews: [] }}
      />,
    );

    expect(html).toContain("majstrovská úroveň");
    expect(html).toContain("za m²");
    expect(html).toContain("Oprávnenie pre Obkladač");
    expect(html).not.toContain("MASTER");
    expect(html).not.toContain("PER_SQUARE_METER");
    expect(html).not.toContain("ELECTRICAL_INSPECTION");
  });
});

function profile(): PublicCraftsmanProfile {
  return {
    callToAction: { kind: "PLATFORM_JOB_REQUEST" },
    credentials: [
      {
        credentialTypeCode: "ELECTRICAL_INSPECTION",
        expiresOn: "2030-12-31",
        professionCode: "PROF:TILER",
        verification: "ADMIN_APPROVED",
      },
    ],
    experience: { source: "SELF_DECLARED", workingSinceYear: 2014 },
    identity: {
      about: "Obklady a rekonštrukcie s dôrazom na čisté prevedenie.",
      primaryName: "Poctivé obklady",
      profileType: "COMPANY",
      secondaryName: null,
    },
    indicativePricing: [
      {
        amountCents: 3_500,
        currency: "EUR",
        mode: "PER_SQUARE_METER",
        note: "Podľa podkladu.",
        professionCode: "PROF:TILER",
        serviceName: "Pokládka obkladu",
      },
    ],
    location: {
      baseMunicipality: { code: "SK-BL", name: "Bratislava" },
      extraMunicipalities: [{ code: "SK-SC", name: "Senec" }],
      normalRadiusMeters: 30_000,
    },
    portfolio: [
      {
        approximateLocation: {
          districtCode: "BA1",
          municipalityCode: "SK-BL",
        },
        contribution: "Kompletná realizácia obkladu",
        duration: { unit: "WEEKS", value: 2 },
        indicativePrice: {
          currency: "EUR",
          maxCents: 350_000,
          minCents: 300_000,
        },
        materialsAndTechnologies: "Veľkoformátová dlažba",
        photos: [
          {
            displayOrder: 1,
            height: 800,
            mediaAssetId: "84000000-0000-4000-8000-000000000003",
            phase: "BEFORE",
            width: 1200,
          },
        ],
        problem: "Poškodený pôvodný povrch",
        professions: [{ code: "PROF:TILER", label: "Obkladač" }],
        projectId:
          "84000000-0000-4000-8000-000000000002" as PublicCraftsmanProfile["portfolio"][number]["projectId"],
        provenance: { evidenceStatus: "UNVERIFIED", kind: "SELF_DECLARED" },
        shortDescription: "Obnova kúpeľne v rodinnom dome.",
        skills: [{ canonicalCode: null, label: "Veľké formáty" }],
        solution: "Vyrovnanie podkladu a nová pokládka",
        specializations: [{ code: "SPEC:BATHROOM", label: "Kúpeľne" }],
        title: "Rekonštrukcia kúpeľne",
      },
    ],
    professions: [
      {
        code: "PROF:TILER",
        customerScore: 4.8,
        declaredProficiency: { level: "MASTER", source: "SELF_DECLARED" },
        evidenceSupportedProficiency: {
          level: "ADVANCED",
          source: "EVIDENCE_SUPPORTED",
        },
        label: "Obkladač",
        reviewCount: 12,
        supervisorEvaluationCount: 2,
        verifiedJobCount: 3,
      },
    ],
    profileId:
      "84000000-0000-4000-8000-000000000001" as PublicCraftsmanProfile["profileId"],
    skills: [
      {
        canonicalCode: "SKILL:LARGE_FORMAT",
        declared: { label: "Veľkoformátové obklady", source: "SELF_DECLARED" },
        evidenceSupported: true,
        professionCodes: ["PROF:TILER"],
      },
    ],
    specializations: [
      {
        code: "SPEC:BATHROOM",
        declared: { label: "Kúpeľne", source: "SELF_DECLARED" },
        evidenceSupported: false,
        professionCode: "PROF:TILER",
      },
    ],
    trust: {
      companyRegistrationVerified: true,
      customerScore: 4.8,
      identityVerified: true,
      reviewCount: 12,
      supervisorEvaluationCount: 2,
      verifiedWorkCount: 3,
    },
  };
}
