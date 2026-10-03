import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveGovernedCityAreas } from "../src/governed-city-areas.js";
import { loadSlovakiaLocationReferenceSnapshot } from "../src/slovakia-location-reference.js";

const snapshotPath = fileURLToPath(
  new URL(
    "../../../reference-data/slovakia-locations/2026-04/snapshot.json",
    import.meta.url,
  ),
);

describe("governed whole-city areas", () => {
  it("derives only official Bratislava and Kosice parents with exact member counts", async () => {
    const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);

    const areas = deriveGovernedCityAreas(snapshot);

    expect(
      areas.map(({ code, memberCodes, name, regionCode }) => ({
        code,
        memberCount: memberCodes.length,
        name,
        regionCode,
      })),
    ).toEqual([
      {
        code: "582000",
        memberCount: 17,
        name: "Bratislava",
        regionCode: "SK010",
      },
      {
        code: "599981",
        memberCount: 22,
        name: "Košice",
        regionCode: "SK042",
      },
    ]);
    expect(
      areas.every(
        ({ memberCodes }) => new Set(memberCodes).size === memberCodes.length,
      ),
    ).toBe(true);
  });

  it("fails closed when an official member set changes", async () => {
    const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);
    const altered = {
      ...snapshot,
      municipalities: snapshot.municipalities.filter(
        ({ name }) => name !== "Bratislava-Čunovo",
      ),
    };

    expect(() => deriveGovernedCityAreas(altered)).toThrow(
      "Governed city area Bratislava changed.",
    );
  });
});
