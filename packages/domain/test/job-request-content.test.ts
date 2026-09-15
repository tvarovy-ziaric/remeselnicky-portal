import { describe, expect, it } from "vitest";

import {
  jobRequestContentMissingSubmissionRequirements,
  JOB_REQUEST_CONTENT_SECTION_KEYS,
  JOB_REQUEST_DOCUMENT_TECHNICAL_LIMIT,
  JOB_REQUEST_MAX_BUDGET_CENTS,
  JOB_REQUEST_MAX_PHOTOS,
  JobRequestContentValidationError,
  normalizeJobRequestContentSection,
  normalizeJobRequestContentSections,
} from "../src/job-request-content.js";

const mediaId = (index: number) =>
  `99000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

describe("job request content", () => {
  it("normalizes all six versioned sections into the generic autosave envelope", () => {
    const sections = normalizeJobRequestContentSections(allSections());
    expect(sections.map(({ key }) => key)).toEqual([
      "request.budget",
      "request.core",
      "request.details",
      "request.location",
      "request.media",
      "request.timing",
    ]);
    expect(new Set(sections.map(({ schemaVersion }) => schemaVersion))).toEqual(
      new Set([1]),
    );
    expect(sections.find(({ key }) => key === "request.core")).toMatchObject({
      payload: {
        description: "Vybúrať staré jadro.\nOsadiť nový obklad.",
        primaryProfessionCode: "PROF:TILER",
        relatedProfessionCodes: ["PROF:MASON"],
        skillCodes: ["SKILL:CUT", "SKILL:GRIP"],
        title: "Rekonštrukcia kúpeľne",
      },
      schemaVersion: 1,
    });
    expect(sections.every(Object.isFrozen)).toBe(true);
    expect(
      sections.every(({ canonicalPayload }) => {
        const parsed = JSON.parse(canonicalPayload) as unknown;
        return typeof parsed === "object" && parsed !== null;
      }),
    ).toBe(true);
  });

  it("reports only the locked submission minimum", () => {
    const incomplete = normalizeJobRequestContentSections([
      core({ description: "", primaryProfessionCode: null }),
      location({ municipalityCode: null }),
      timing(),
      budget(),
      details(),
      media(),
    ]);
    expect(jobRequestContentMissingSubmissionRequirements(incomplete)).toEqual([
      "PRIMARY_PROFESSION",
      "DESCRIPTION",
      "MUNICIPALITY",
    ]);
    expect(
      jobRequestContentMissingSubmissionRequirements(
        normalizeJobRequestContentSections(allSections()),
      ),
    ).toEqual([]);
  });

  it("preserves private exact location only inside the private location section", () => {
    const section = normalizeJobRequestContentSection(location());
    expect(section.payload).toMatchObject({
      exactAddress: "Hlavná 12, byt 3",
      mapPin: { latitude: 48.1486, longitude: 17.1077 },
      municipalityCode: "SK0101528595",
    });
    expect(section.canonicalPayload).not.toContain("email");
  });

  it("accepts each locked timing, budget, material and inspection choice", () => {
    for (const mode of [
      "AS_SOON_AS_POSSIBLE",
      "FLEXIBLE",
      "SPECIFIC_PERIOD",
    ] as const) {
      expect(
        normalizeJobRequestContentSection(
          timing(
            mode === "SPECIFIC_PERIOD"
              ? { endsOn: "2027-06-30", mode, startsOn: "2027-06-01" }
              : { endsOn: null, mode, startsOn: null },
          ),
        ).payload,
      ).toMatchObject({ mode });
    }
    expect(
      normalizeJobRequestContentSection(
        budget({
          maximumAmountCents: null,
          minimumAmountCents: null,
          mode: "UNKNOWN",
        }),
      ).payload,
    ).toMatchObject({
      maximumAmountCents: null,
      minimumAmountCents: null,
      mode: "UNKNOWN",
    });
    expect(
      normalizeJobRequestContentSection(
        budget({
          maximumAmountCents: 250_000,
          minimumAmountCents: null,
          mode: "UP_TO",
        }),
      ).payload,
    ).toMatchObject({ maximumAmountCents: 250_000, mode: "UP_TO" });
    expect(
      normalizeJobRequestContentSection(
        budget({
          maximumAmountCents: JOB_REQUEST_MAX_BUDGET_CENTS,
          minimumAmountCents: 1,
          mode: "RANGE",
        }),
      ).payload,
    ).toMatchObject({ mode: "RANGE" });
    expect(normalizeJobRequestContentSection(details()).payload).toMatchObject({
      materialResponsibility: "ADVICE_NEEDED",
      siteInspection: "MAYBE",
    });
  });

  it("allows exactly ten photos and bounded optional documents but no video field", () => {
    const maximum = normalizeJobRequestContentSection(
      media({
        documentMediaAssetIds: Array.from(
          { length: JOB_REQUEST_DOCUMENT_TECHNICAL_LIMIT },
          (_, index) => mediaId(index + 100),
        ),
        photoMediaAssetIds: Array.from(
          { length: JOB_REQUEST_MAX_PHOTOS },
          (_, index) => mediaId(index),
        ),
      }),
    );
    expect("photoMediaAssetIds" in maximum.payload).toBe(true);
    if (!("photoMediaAssetIds" in maximum.payload)) {
      throw new Error("Expected media section.");
    }
    expect(maximum.payload.photoMediaAssetIds).toHaveLength(
      JOB_REQUEST_MAX_PHOTOS,
    );
    expect(() =>
      normalizeJobRequestContentSection(
        media({
          photoMediaAssetIds: Array.from(
            { length: JOB_REQUEST_MAX_PHOTOS + 1 },
            (_, index) => mediaId(index),
          ),
        }),
      ),
    ).toThrow(JobRequestContentValidationError);
    expect(() =>
      normalizeJobRequestContentSection({
        ...media(),
        payload: { ...media().payload, videoMediaAssetIds: [mediaId(500)] },
      }),
    ).toThrow(JobRequestContentValidationError);
  });

  it.each([
    ["unknown key", { ...core(), key: "helper-answers" }],
    ["wrong version", { ...core(), schemaVersion: 2 }],
    [
      "extra property",
      { ...core(), payload: { ...core().payload, ownerUserId: mediaId(1) } },
    ],
    ["bad profession", core({ primaryProfessionCode: "owner@example.test" })],
    [
      "duplicate related profession",
      core({ relatedProfessionCodes: ["PROF:MASON", "PROF:MASON"] }),
    ],
    [
      "primary repeated as related",
      core({ relatedProfessionCodes: ["PROF:TILER"] }),
    ],
    [
      "invalid municipality",
      location({ municipalityCode: "Bratislava owner@example.test" }),
    ],
    ["invalid latitude", location({ mapPin: { latitude: 91, longitude: 17 } })],
    [
      "email in description",
      core({ description: "Napíšte na owner@example.test" }),
    ],
    [
      "phone in requirements",
      details({ customRequirements: "Volajte +421 900 111 222" }),
    ],
    ["control character", core({ description: "Práca\u0000tajná" })],
    [
      "invalid calendar date",
      timing({ mode: "SPECIFIC_PERIOD", startsOn: "2027-02-30" }),
    ],
    [
      "end before start",
      timing({
        endsOn: "2027-05-01",
        mode: "SPECIFIC_PERIOD",
        startsOn: "2027-06-01",
      }),
    ],
    ["date on flexible", timing({ mode: "FLEXIBLE", startsOn: "2027-06-01" })],
    ["zero budget", budget({ maximumAmountCents: 0, mode: "UP_TO" })],
    ["amount without budget mode", budget({ mode: null })],
    [
      "missing up-to maximum",
      budget({
        maximumAmountCents: null,
        minimumAmountCents: null,
        mode: "UP_TO",
      }),
    ],
    ["incomplete range", budget({ maximumAmountCents: null, mode: "RANGE" })],
    [
      "reversed budget",
      budget({
        maximumAmountCents: 100,
        minimumAmountCents: 200,
        mode: "RANGE",
      }),
    ],
    [
      "duplicate media",
      media({ photoMediaAssetIds: [mediaId(1), mediaId(1)] }),
    ],
  ])("rejects %s", (_name, section) => {
    expect(() => normalizeJobRequestContentSection(section)).toThrow(
      JobRequestContentValidationError,
    );
  });

  it("rejects duplicate sections and leaves optional fields non-blocking", () => {
    expect(() => normalizeJobRequestContentSections([core(), core()])).toThrow(
      JobRequestContentValidationError,
    );
    const minimum = normalizeJobRequestContentSections([
      core({
        description: "Opraviť obklad",
        primaryProfessionCode: "PROF:TILER",
        relatedProfessionCodes: [],
        skillCodes: [],
        specializationCode: null,
        title: null,
      }),
      location({
        exactAddress: null,
        mapPin: null,
        municipalityCode: "SK0101528595",
        textClarification: null,
      }),
    ]);
    expect(jobRequestContentMissingSubmissionRequirements(minimum)).toEqual([]);
  });

  expect(JOB_REQUEST_CONTENT_SECTION_KEYS).toHaveLength(6);
});

function allSections() {
  return [core(), location(), timing(), budget(), details(), media()];
}

function core(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.core",
    payload: {
      description: "  Vybúrať staré jadro.\r\nOsadiť nový obklad.  ",
      primaryProfessionCode: "PROF:TILER",
      relatedProfessionCodes: ["PROF:MASON"],
      skillCodes: ["SKILL:GRIP", "SKILL:CUT"],
      specializationCode: "SPEC:BATHROOM",
      title: " Rekonštrukcia kúpeľne ",
      ...overrides,
    },
    schemaVersion: 1,
  };
}

function location(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.location",
    payload: {
      exactAddress: " Hlavná 12, byt 3 ",
      mapPin: { latitude: 48.1486, longitude: 17.1077 },
      municipalityCode: "SK0101528595",
      textClarification: "Vchod zo dvora",
      ...overrides,
    },
    schemaVersion: 1,
  };
}

function timing(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.timing",
    payload: {
      completionDeadline: "2027-07-15",
      endsOn: "2027-06-30",
      mode: "SPECIFIC_PERIOD",
      startsOn: "2027-06-01",
      ...overrides,
    },
    schemaVersion: 1,
  };
}

function budget(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.budget",
    payload: {
      currency: "EUR",
      maximumAmountCents: 300_000,
      minimumAmountCents: 150_000,
      mode: "RANGE",
      ...overrides,
    },
    schemaVersion: 1,
  };
}

function details(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.details",
    payload: {
      approximateQuantity: "12 m²",
      customRequirements: "Bezbariérový sprchový kút",
      materialResponsibility: "ADVICE_NEEDED",
      siteInspection: "MAYBE",
      ...overrides,
    },
    schemaVersion: 1,
  };
}

function media(overrides: Record<string, unknown> = {}) {
  return {
    key: "request.media",
    payload: {
      documentMediaAssetIds: [mediaId(20)],
      photoMediaAssetIds: [mediaId(10), mediaId(11)],
      ...overrides,
    },
    schemaVersion: 1,
  };
}
