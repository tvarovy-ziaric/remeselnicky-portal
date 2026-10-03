import type { SlovakiaLocationReferenceSnapshot } from "./slovakia-location-reference.js";

export interface GovernedCityArea {
  readonly code: string;
  readonly districtCode: string;
  readonly memberCodes: readonly string[];
  readonly name: string;
  readonly regionCode: string;
  readonly sourceRevision: string;
}

const definitions = Object.freeze([
  Object.freeze({
    code: "582000",
    districtCode: "SCOPE:582000",
    expectedMemberCount: 17,
    memberNamePrefix: "Bratislava-",
    name: "Bratislava",
  }),
  Object.freeze({
    code: "599981",
    districtCode: "SCOPE:599981",
    expectedMemberCount: 22,
    memberNamePrefix: "Košice-",
    name: "Košice",
  }),
] as const);

/**
 * Derives only the two Slovak statutory cities whose official selectable
 * records consist exclusively of city districts in the pinned snapshot.
 * Counts are fail-closed so a future source change requires an explicit data
 * review rather than silently widening or narrowing a whole-city selection.
 */
export function deriveGovernedCityAreas(
  snapshot: SlovakiaLocationReferenceSnapshot,
): readonly GovernedCityArea[] {
  const districtRegion = new Map(
    snapshot.districts.map(({ code, regionCode }) => [code, regionCode]),
  );
  const areas = definitions.map((definition) => {
    const members = snapshot.municipalities.filter(({ name }) =>
      name.startsWith(definition.memberNamePrefix),
    );
    if (
      members.length !== definition.expectedMemberCount ||
      snapshot.municipalities.some(({ name }) => name === definition.name)
    ) {
      throw new Error(`Governed city area ${definition.name} changed.`);
    }
    const regionCodes = new Set(
      members.map(({ districtCode }) => districtRegion.get(districtCode)),
    );
    if (regionCodes.size !== 1 || regionCodes.has(undefined)) {
      throw new Error(`Governed city area ${definition.name} is ambiguous.`);
    }
    return Object.freeze({
      code: definition.code,
      districtCode: definition.districtCode,
      memberCodes: Object.freeze(members.map(({ code }) => code).sort()),
      name: definition.name,
      regionCode: [...regionCodes][0]!,
      sourceRevision: `${snapshot.source.revision}+city-areas-v1`,
    });
  });
  return Object.freeze(areas);
}
