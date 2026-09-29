import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadSlovakiaLocationReferenceSnapshot,
  validateSlovakiaLocationReferenceSnapshot,
} from "../src/slovakia-location-reference.js";

const snapshotPath = fileURLToPath(
  new URL(
    "../../../reference-data/slovakia-locations/2026-04/snapshot.json",
    import.meta.url,
  ),
);

describe("official Slovak location reference snapshot", () => {
  it("validates the committed deterministic official snapshot", async () => {
    const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);

    expect(snapshot.counts).toEqual({
      regions: 8,
      districts: 79,
      municipalities: 2_924,
      postalCodes: 1_415,
      municipalityPostalCodes: 3_283,
    });
    expect(snapshot.source.rawSha256).toBe(
      "312b38f506ee2f635fca0dd9c3a413d0e789506713919b5c3d78a5780a6fdbd3",
    );
  });

  it("keeps authoritative municipality codes distinct from postal codes", async () => {
    const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);

    expect(snapshot.municipalities).toContainEqual(
      expect.objectContaining({ code: "513881", name: "Prievidza" }),
    );
    expect(snapshot.municipalityPostalCodes).toContainEqual({
      municipalityCode: "513881",
      postalCode: "97101",
      isPrimary: false,
    });
    expect(snapshot.municipalities).toContainEqual(
      expect.objectContaining({ code: "513792", name: "Malá Tŕňa" }),
    );
  });

  it("represents both sides of the postal-code many-to-many relationship", async () => {
    const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);
    const linksByMunicipality = new Map<string, number>();
    const linksByPostalCode = new Map<string, number>();
    for (const link of snapshot.municipalityPostalCodes) {
      linksByMunicipality.set(
        link.municipalityCode,
        (linksByMunicipality.get(link.municipalityCode) ?? 0) + 1,
      );
      linksByPostalCode.set(
        link.postalCode,
        (linksByPostalCode.get(link.postalCode) ?? 0) + 1,
      );
    }

    expect([...linksByMunicipality.values()].some((count) => count > 1)).toBe(
      true,
    );
    expect([...linksByPostalCode.values()].some((count) => count > 1)).toBe(
      true,
    );
  });

  it("fails closed on altered records or checksum", async () => {
    const snapshot = await loadSlovakiaLocationReferenceSnapshot(snapshotPath);
    const altered = {
      ...snapshot,
      municipalities: snapshot.municipalities.map((municipality, index) =>
        index === 0 ? { ...municipality, name: "Tampered" } : municipality,
      ),
    };

    expect(() => validateSlovakiaLocationReferenceSnapshot(altered)).toThrow(
      "checksum mismatch",
    );
  });
});
