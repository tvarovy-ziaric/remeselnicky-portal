import { readFile } from "node:fs/promises";

import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";

import { createPublicSearchCardSource } from "../src/public-search-card-source.js";

describe("public search card source", () => {
  it("opens one repeatable-read snapshot and fails closed above the post-filter cap", async () => {
    const modes: string[] = [];
    const transaction = ((fragments: TemplateStringsArray) => {
      const statement = fragments.join("?");
      if (statement.includes("WITH profession_release")) {
        return Promise.resolve([
          {
            code: "PROF:TILER",
            kind: "PROFESSION",
            label: "Obkladač",
            professionCodes: ["PROF:TILER"],
          },
        ]);
      }
      if (statement.includes("SELECT profile.craftsman_profile_id")) {
        return Promise.resolve(
          Array.from({ length: 101 }, (_, index) => ({
            profileId: `99000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          })),
        );
      }
      return Promise.reject(new Error(`Unexpected test SQL: ${statement}`));
    }) as unknown as TransactionSql;
    const sql = Object.assign(() => Promise.resolve([]), {
      begin: async <Result>(
        mode: string,
        use: (tx: TransactionSql) => Promise<Result>,
      ) => {
        modes.push(mode);
        return use(transaction);
      },
    }) as unknown as Sql;
    const source = createPublicSearchCardSource(sql);
    await expect(
      source.withAuthoritativeCohort(query(), 100, () =>
        Promise.resolve("should-not-run"),
      ),
    ).rejects.toThrow(/safety cap/u);
    expect(modes).toEqual(["isolation level repeatable read read only"]);
  });

  it("prefilters exact profession and identity and restricts facts before composition", async () => {
    const source = await readFile(
      new URL("../src/public-search-card-source.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /JOIN current_searchable_craftsman_professions profession[\s\S]*profession\.profession_code = \$\{query\.professionCode\}[\s\S]*identity_search_document[\s\S]*LIMIT \$\{maximumCandidates \+ 1\}/u,
    );
    expect(source).toMatch(
      /craftsman_service_area_match_facts[\s\S]*WHERE match\.craftsman_profile_id = ANY\(\$\{candidateIds\}::uuid\[\]\)/u,
    );
    expect(source).toMatch(
      /craftsman_availability_match_facts[\s\S]*WHERE availability\.craftsman_profile_id = ANY\(\$\{candidateIds\}::uuid\[\]\)/u,
    );
    expect(source).toMatch(
      /FROM unnest\(\$\{profileIds\}::uuid\[\]\) selected\(profile_id\)[\s\S]*evaluate_craftsman_credential_qualification/u,
    );
    expect(source).not.toMatch(
      /ranking_distance_meters.*send|exact_address|storage_key/iu,
    );
  });
});

function query() {
  return {
    afterProfileId: null,
    filterIndicativelyAvailable: false,
    identityQuery: "Majster",
    includeOutsideDeclaredArea: false,
    limit: 20,
    municipalityCode: null,
    professionCode: "PROF:TILER",
    skillCodes: [],
    sort: "RECOMMENDED" as const,
    specializationCode: null,
    timing: null,
  };
}
