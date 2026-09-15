import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

import { createMunicipalityAutocompleteRepository } from "../src/municipality-autocomplete-repository.js";

describe("municipality autocomplete repository", () => {
  it("uses active governed hierarchy and returns an allowlisted row", async () => {
    let query = "";
    const sql = vi.fn((strings: TemplateStringsArray) => {
      query = strings.join("?");
      return Promise.resolve([
        {
          code: "SK:BA:BRATISLAVA",
          districtName: "Bratislava I",
          name: "Bratislava",
          regionName: "Bratislavský kraj",
        },
      ]);
    }) as unknown as Sql;
    const result =
      await createMunicipalityAutocompleteRepository(sql).suggest("Brati");
    expect(result).toEqual([
      {
        code: "SK:BA:BRATISLAVA",
        districtName: "Bratislava I",
        name: "Bratislava",
        regionName: "Bratislavský kraj",
      },
    ]);
    expect(query).toMatch(/location_municipalities|is_active|LIMIT 10/u);
    expect(query).not.toMatch(/centroid|owner_user|exact_address/iu);
  });

  it("does not query malformed or empty input", async () => {
    const query = vi.fn();
    const sql = query as unknown as Sql;
    const repository = createMunicipalityAutocompleteRepository(sql);
    await expect(repository.suggest(" ")).resolves.toEqual([]);
    await expect(repository.suggest("a\nprivate")).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on malformed database rows", async () => {
    const sql = vi.fn(() =>
      Promise.resolve([
        { code: "bad code", districtName: "D", name: "N", regionName: "R" },
      ]),
    ) as unknown as Sql;
    await expect(
      createMunicipalityAutocompleteRepository(sql).suggest("obec"),
    ).rejects.toThrow("invalid");
  });
});
