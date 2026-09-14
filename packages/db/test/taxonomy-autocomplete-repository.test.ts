import { createTaxonomyAutocompleteService } from "@portal/search";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { createTaxonomyAutocompleteRepository } from "../src/taxonomy-autocomplete-repository.js";

describe("taxonomy autocomplete repository", () => {
  it("queries only activated, approved canonical catalogs with governed aliases", async () => {
    const sql = scriptedSql([
      [
        {
          activated: true,
          code: "PROF:TILER",
          contentClass: "CANONICAL",
          entryState: "ACTIVE",
          kind: "PROFESSION",
          label: "Obkladač",
          matchedBy: "EXACT_ALIAS",
          professionCodes: ["PROF:TILER"],
          rawAlias: "never-return-this-alias",
          reviewState: "HUMAN_REVIEW_APPROVED",
        },
      ],
    ]);
    const autocomplete = createTaxonomyAutocompleteService(
      createTaxonomyAutocompleteRepository(sql),
    );

    const result = await autocomplete.autocomplete({
      limit: "5",
      query: "OBKLÁDAČ",
    });
    expect(result).toEqual({
      status: "OK",
      suggestions: [
        {
          code: "PROF:TILER",
          kind: "PROFESSION",
          label: "Obkladač",
          matchedBy: "EXACT_ALIAS",
          professionCodes: ["PROF:TILER"],
        },
      ],
    });

    const query = sql.queries[0] ?? "";
    expect(query).toContain("profession_taxonomy_activation_events");
    expect(query).toContain("skill_catalog_activation_events");
    expect(query).toContain("content_class = 'CANONICAL'");
    expect(query).toContain("review_state = 'HUMAN_REVIEW_APPROVED'");
    expect(query).toContain("taxonomy_aliases");
    expect(query).toContain("'LEGACY_CODE', 'LEGACY_SLUG', 'SEARCH_TERM'");
    expect(query).toContain("skill_catalog_skill_professions");
    expect(query).toContain("profession.state = 'ACTIVE'");
    expect(query).toContain("skill.state = 'ACTIVE'");
    expect(query).toContain('COLLATE "C"');
    expect(query).not.toMatch(
      /unaccent|craftsman_profiles|popularity|usage_count|tag_count/iu,
    );
    expect(sql.values.flat()).toContain("obkladac");
    expect(sql.values.flat()).not.toContain("OBKLÁDAČ");
    expect(JSON.stringify(result)).not.toContain("never-return-this-alias");
  });

  it("fails closed when persistence data claims inactive governance", async () => {
    const sql = scriptedSql([
      [
        {
          activated: true,
          code: "PROF:TILER",
          contentClass: "CANONICAL",
          entryState: "DEPRECATED",
          kind: "PROFESSION",
          label: "Obkladač",
          matchedBy: "EXACT_CANONICAL",
          professionCodes: ["PROF:TILER"],
          reviewState: "HUMAN_REVIEW_APPROVED",
        },
      ],
    ]);
    await expect(
      createTaxonomyAutocompleteService(
        createTaxonomyAutocompleteRepository(sql),
      ).autocomplete({ query: "obkladac" }),
    ).rejects.toThrow(/governed output invariants/u);
  });

  it("rejects malformed internal queries before opening SQL", async () => {
    const sql = scriptedSql([]);
    const repository = createTaxonomyAutocompleteRepository(sql);
    await expect(
      repository.findCandidates({
        limit: 10,
        normalizedText: "unsafe@example.test",
        tokens: ["unsafe@example.test"],
      }),
    ).rejects.toThrow(TypeError);
    expect(sql.queries).toEqual([]);
  });
});

interface ScriptedSql {
  readonly queries: string[];
  readonly values: unknown[][];
}

function scriptedSql(responses: readonly unknown[][]): Sql & ScriptedSql {
  const queue = [...responses];
  const queries: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    queries.push(
      strings.reduce(
        (query, fragment, index) =>
          `${query}${fragment}${index < parameters.length ? `$${index + 1}` : ""}`,
        "",
      ),
    );
    values.push(parameters);
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as Sql & ScriptedSql;
  Object.defineProperties(sql, {
    queries: { value: queries },
    values: { value: values },
  });
  return sql;
}
