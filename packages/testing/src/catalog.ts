import type { ProfessionTaxonomySeed, SlovakLocationSeed } from "./model.js";

const locationCodePattern = /^SK:[A-Z0-9][A-Z0-9_-]{1,47}$/u;
const professionCodePattern = /^TEST:[A-Z0-9][A-Z0-9_-]{1,43}$/u;

export const SYNTHETIC_SLOVAK_LOCATIONS = prepareSlovakLocationSeeds([
  {
    code: "SK:TEST_WEST",
    countryCode: "SK",
    displayName: "Syntetická slovenská lokalita západ",
    kind: "SYNTHETIC_TEST_AREA",
    parentCode: null,
    synthetic: true,
  },
  {
    code: "SK:TEST_EAST",
    countryCode: "SK",
    displayName: "Syntetická slovenská lokalita východ",
    kind: "SYNTHETIC_TEST_AREA",
    parentCode: null,
    synthetic: true,
  },
]);

export const PLACEHOLDER_PROFESSION_TAXONOMY = prepareProfessionTaxonomySeeds([
  {
    code: "TEST:PROFESSION_A",
    displayName: "Syntetické remeslo A",
    placeholder: true,
    synthetic: true,
  },
  {
    code: "TEST:PROFESSION_B",
    displayName: "Syntetické remeslo B",
    placeholder: true,
    synthetic: true,
  },
]);

export function prepareSlovakLocationSeeds(
  values: readonly SlovakLocationSeed[],
): readonly SlovakLocationSeed[] {
  const byCode = new Map<string, SlovakLocationSeed>();
  for (const value of values) {
    if (value.countryCode !== "SK" || !locationCodePattern.test(value.code)) {
      throw new TypeError(
        "Slovak location seed must use country SK and a stable SK: code.",
      );
    }
    if (value.displayName.trim().length < 2 || value.displayName.length > 120) {
      throw new TypeError(
        "Slovak location display name must be meaningful and bounded.",
      );
    }
    if (byCode.has(value.code)) {
      throw new TypeError(`Duplicate Slovak location seed code: ${value.code}`);
    }
    byCode.set(value.code, value);
  }

  for (const value of values) {
    if (value.parentCode !== null && !byCode.has(value.parentCode)) {
      throw new TypeError(
        `Unknown Slovak location parent: ${value.parentCode}`,
      );
    }
    assertNoParentCycle(value.code, byCode);
  }
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

export function prepareProfessionTaxonomySeeds(
  values: readonly ProfessionTaxonomySeed[],
): readonly ProfessionTaxonomySeed[] {
  const codes = new Set<string>();
  for (const value of values) {
    if (!professionCodePattern.test(value.code)) {
      throw new TypeError(
        "R0 profession placeholders must use a stable TEST: code.",
      );
    }
    if (!value.placeholder || !value.synthetic) {
      throw new TypeError(
        "R0 profession entries must remain synthetic placeholders.",
      );
    }
    if (value.displayName.trim().length < 2 || value.displayName.length > 120) {
      throw new TypeError(
        "Profession placeholder display name must be meaningful and bounded.",
      );
    }
    if (codes.has(value.code)) {
      throw new TypeError(
        `Duplicate profession placeholder code: ${value.code}`,
      );
    }
    codes.add(value.code);
  }
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

function assertNoParentCycle(
  startCode: string,
  byCode: ReadonlyMap<string, SlovakLocationSeed>,
): void {
  const visited = new Set<string>();
  let code: string | null = startCode;
  while (code !== null) {
    if (visited.has(code)) {
      throw new TypeError(
        `Slovak location parent cycle includes: ${startCode}`,
      );
    }
    visited.add(code);
    code = byCode.get(code)?.parentCode ?? null;
  }
}
