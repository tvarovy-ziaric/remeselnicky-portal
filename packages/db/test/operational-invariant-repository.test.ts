import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  createOperationalInvariantRepository,
  OPERATIONAL_INVARIANT_NAMES,
} from "../src/operational-invariant-repository.js";

describe("D29 operational invariant repository", () => {
  it("returns every bounded aggregate without exposing entity identifiers", async () => {
    const statements: string[] = [];
    const rows = OPERATIONAL_INVARIANT_NAMES.map((name) => ({
      name,
      violationCount: name === "COMPLETED_JOB_CONTEXT" ? 1 : 0,
    }));
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?"));
      return Promise.resolve(rows);
    }) as unknown as Sql;

    await expect(
      createOperationalInvariantRepository(sql).check(),
    ).resolves.toEqual(rows);
    expect(statements).toHaveLength(1);
    expect(rows.every((row) => Object.keys(row).length === 2)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/user|job_?id|email|phone/iu);
  });

  it("fails closed for an incomplete or invalid checker result", async () => {
    const incomplete = (() => Promise.resolve([])) as unknown as Sql;
    await expect(
      createOperationalInvariantRepository(incomplete).check(),
    ).rejects.toThrow(/incomplete/u);

    const invalidRows = OPERATIONAL_INVARIANT_NAMES.map((name) => ({
      name,
      violationCount: name === "COMPLETED_JOB_CONTEXT" ? -1 : 0,
    }));
    const invalid = (() => Promise.resolve(invalidRows)) as unknown as Sql;
    await expect(
      createOperationalInvariantRepository(invalid).check(),
    ).rejects.toThrow(/invalid count/u);
  });
});
