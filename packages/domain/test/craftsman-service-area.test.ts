import { describe, expect, it } from "vitest";

import {
  ALPHA_EXTRA_SERVICE_AREA_UI_LIMIT,
  assertReplaceCraftsmanServiceAreaInput,
  CraftsmanServiceAreaValidationError,
  normalizeTravelFeePolicy,
  SERVICE_AREA_EXTRA_TECHNICAL_LIMIT,
  type CraftsmanProfileId,
  type MunicipalityCode,
  type ReplaceCraftsmanServiceAreaInput,
  type UserId,
} from "../src/index.js";

const base = "TEST:MUNICIPALITY_BASE" as MunicipalityCode;

describe("craftsman service-area commands", () => {
  it("accepts an incomplete private draft and a complete profile-wide preference", () => {
    expect(() =>
      assertReplaceCraftsmanServiceAreaInput(command()),
    ).not.toThrow();
    for (const normalRadiusKm of [0.29, 1.15]) {
      expect(() =>
        assertReplaceCraftsmanServiceAreaInput({
          ...command(),
          normalRadiusKm,
        }),
      ).not.toThrow();
    }
    expect(() =>
      assertReplaceCraftsmanServiceAreaInput({
        ...command(),
        baseMunicipalityCode: base,
        extraMunicipalityCodes: ["TEST:MUNICIPALITY_EXTRA" as MunicipalityCode],
        maximumRadiusKm: 80,
        normalRadiusKm: 30,
        travelFeePolicy: "Cestovné podľa dohody v cenovej ponuke.",
        travelFeeThresholdKm: 40,
      }),
    ).not.toThrow();
    for (const partial of [
      { baseMunicipalityCode: base },
      { normalRadiusKm: 15 },
      { travelFeeThresholdKm: 20 },
    ]) {
      expect(() =>
        assertReplaceCraftsmanServiceAreaInput({ ...command(), ...partial }),
      ).not.toThrow();
    }
  });

  it("keeps the UI near three extras while the backend remains extensible", () => {
    expect(ALPHA_EXTRA_SERVICE_AREA_UI_LIMIT).toBe(3);
    expect(SERVICE_AREA_EXTRA_TECHNICAL_LIMIT).toBe(256);
    expect(() =>
      assertReplaceCraftsmanServiceAreaInput({
        ...command(),
        extraMunicipalityCodes: [
          "TEST:1",
          "TEST:2",
          "TEST:3",
          "TEST:4",
        ] as MunicipalityCode[],
      }),
    ).not.toThrow();
    for (const extraMunicipalityCodes of [
      [base],
      ["TEST:X" as MunicipalityCode, "TEST:X" as MunicipalityCode],
      Array.from(
        { length: SERVICE_AREA_EXTRA_TECHNICAL_LIMIT + 1 },
        (_, index) => `TEST:${index}` as MunicipalityCode,
      ),
    ]) {
      expect(() =>
        assertReplaceCraftsmanServiceAreaInput({
          ...command(),
          baseMunicipalityCode: base,
          extraMunicipalityCodes,
        }),
      ).toThrow(CraftsmanServiceAreaValidationError);
    }
  });

  it("rejects arbitrary location labels, invalid radii and unsafe policy text", () => {
    const invalidInputs: ReplaceCraftsmanServiceAreaInput[] = [
      { ...command(), baseMunicipalityCode: "Bratislava" as MunicipalityCode },
      { ...command(), normalRadiusKm: 0 },
      { ...command(), normalRadiusKm: Number.POSITIVE_INFINITY },
      { ...command(), normalRadiusKm: 12.345 },
      { ...command(), maximumRadiusKm: 20, normalRadiusKm: 30 },
      { ...command(), travelFeePolicy: " contains surrounding space " },
      { ...command(), travelFeePolicy: "unsafe\u0001policy" },
      { ...command(), travelFeePolicy: "Napíšte na majster@example.sk" },
      { ...command(), travelFeePolicy: "Viac na https://example.sk" },
      { ...command(), travelFeePolicy: "Volajte +421 900 123 456" },
    ];
    for (const input of invalidInputs) {
      expect(() => assertReplaceCraftsmanServiceAreaInput(input)).toThrow(
        CraftsmanServiceAreaValidationError,
      );
    }
  });

  it("normalizes multiline policy text without turning a threshold into a price", () => {
    expect(
      normalizeTravelFeePolicy("  Bežne bez príplatku.\r\nĎalej dohodou.  "),
    ).toBe("Bežne bez príplatku.\nĎalej dohodou.");
    expect(command()).not.toHaveProperty("travelFeeAmount");
    expect(command()).not.toHaveProperty("calculatedTravelPrice");
  });
});

function command(): ReplaceCraftsmanServiceAreaInput {
  return {
    actorUserId: "61000000-0000-4000-8000-000000000001" as UserId,
    baseMunicipalityCode: null,
    commandId: "61000000-0000-4000-8000-000000000002",
    craftsmanProfileId:
      "61000000-0000-4000-8000-000000000003" as CraftsmanProfileId,
    expectedRevision: 0,
    extraMunicipalityCodes: [],
    maximumRadiusKm: null,
    normalRadiusKm: null,
    travelFeePolicy: null,
    travelFeeThresholdKm: null,
  };
}
