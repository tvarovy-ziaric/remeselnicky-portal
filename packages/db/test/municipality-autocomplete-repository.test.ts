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
          postalCodes: ["81101", "81102"],
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
        postalCodes: ["81101", "81102"],
        regionName: "Bratislavský kraj",
      },
    ]);
    expect(query).toMatch(
      /location_municipalities|location_postal_codes|is_active|LIMIT/u,
    );
    expect(query).toMatch(
      /ORDER BY candidates\.normalized_name, candidates\.code/u,
    );
    expect(query).toMatch(/municipality_postal\.is_active/u);
    expect(query).not.toMatch(/centroid|owner_user|exact_address/iu);
  });

  it("normalizes diacritics and casing for a municipality-name prefix", async () => {
    const interpolations: unknown[][] = [];
    const sql = vi.fn((_: TemplateStringsArray, ...values: unknown[]) => {
      interpolations.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;

    await createMunicipalityAutocompleteRepository(sql).suggest("PRÍE");

    expect(interpolations).toHaveLength(1);
    expect(interpolations[0]).toContain("prie%");
  });

  it.each(["971", "9710", "97101", "971 01", "01001"])(
    "searches canonical postal prefix for %s",
    async (input) => {
      let query = "";
      let values: readonly unknown[] = [];
      const sql = vi.fn(
        (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
          query = strings.join("?");
          values = interpolations;
          return Promise.resolve([
            {
              code: "SK:PD:PRIEVIDZA",
              districtName: "Prievidza",
              name: "Prievidza",
              postalCodes: ["97101"],
              regionName: "Trenčiansky kraj",
            },
          ]);
        },
      ) as unknown as Sql;

      const result =
        await createMunicipalityAutocompleteRepository(sql).suggest(input);

      expect(query).toMatch(
        /location_postal_codes[\s\S]*location_municipality_postal_codes/u,
      );
      expect(query).toMatch(
        /ORDER BY[\s\S]*min\(postal\.code\)[\s\S]*municipality\.code/u,
      );
      expect(query).toMatch(/municipality_postal\.is_active/u);
      expect(values).toContain(`${input.replaceAll(" ", "")}%`);
      expect(result[0]?.postalCodes).toEqual(["97101"]);
    },
  );

  it("returns every shared-code municipality and multiple sorted codes per municipality", async () => {
    const sql = vi.fn(() =>
      Promise.resolve([
        {
          code: "SK:PD:PRIEVIDZA",
          districtName: "Prievidza",
          name: "Prievidza",
          postalCodes: ["97101", "97103"],
          regionName: "Trenčiansky kraj",
        },
        {
          code: "SK:PD:OTHER",
          districtName: "Prievidza",
          name: "Iná obec",
          postalCodes: ["97101"],
          regionName: "Trenčiansky kraj",
        },
      ]),
    ) as unknown as Sql;

    await expect(
      createMunicipalityAutocompleteRepository(sql).suggest("971"),
    ).resolves.toEqual([
      expect.objectContaining({
        code: "SK:PD:PRIEVIDZA",
        postalCodes: ["97101", "97103"],
      }),
      expect.objectContaining({
        code: "SK:PD:OTHER",
        postalCodes: ["97101"],
      }),
    ]);
  });

  it("does not query malformed or empty input", async () => {
    const query = vi.fn();
    const sql = query as unknown as Sql;
    const repository = createMunicipalityAutocompleteRepository(sql);
    await expect(repository.suggest(" ")).resolves.toEqual([]);
    await expect(repository.suggest("a\nprivate")).resolves.toEqual([]);
    await expect(repository.suggest("97")).resolves.toEqual([]);
    await expect(repository.suggest("971001")).resolves.toEqual([]);
    await expect(repository.suggest("971-01")).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed on malformed database rows", async () => {
    const sql = vi.fn(() =>
      Promise.resolve([
        {
          code: "bad code",
          districtName: "D",
          name: "N",
          postalCodes: ["97101"],
          regionName: "R",
        },
      ]),
    ) as unknown as Sql;
    await expect(
      createMunicipalityAutocompleteRepository(sql).suggest("obec"),
    ).rejects.toThrow("invalid");
  });

  it("fails closed on malformed, duplicated, or unsorted postal codes", async () => {
    const sql = vi.fn(() =>
      Promise.resolve([
        {
          code: "SK:PD:PRIEVIDZA",
          districtName: "Prievidza",
          name: "Prievidza",
          postalCodes: ["97103", "97101"],
          regionName: "Trenčiansky kraj",
        },
      ]),
    ) as unknown as Sql;
    await expect(
      createMunicipalityAutocompleteRepository(sql).suggest("Prie"),
    ).rejects.toThrow("invalid");
  });
});
