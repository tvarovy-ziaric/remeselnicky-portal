import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CRAFTSMAN_AVAILABILITY_MATCH_FUNCTION,
  CRAFTSMAN_AVAILABILITY_MATCH_RESULT_COLUMNS,
} from "../src/schema/craftsman-availability-match.js";

const migration = readFileSync(
  new URL(
    "../migrations/0033_craftsman_availability_matching.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("craftsman availability matching SQL boundary", () => {
  it("derives live categorical facts only from 0029 candidates and private current markings", () => {
    expect(migration).toContain(
      `CREATE FUNCTION ${CRAFTSMAN_AVAILABILITY_MATCH_FUNCTION}`,
    );
    expect(migration).toContain("current_searchable_craftsman_profiles");
    expect(migration).toContain("current_craftsman_availability_blocks");
    expect(migration).toContain("marking.state = 'ACTIVE'");
    expect(migration).toContain("STABLE");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).not.toMatch(/CREATE TABLE|MATERIALIZED/iu);
  });

  it("uses bounded half-open UTC overlap with the private calendar limits", () => {
    expect(migration).toContain(
      "query_starts_at >= timestamptz '2000-01-01 00:00:00+00'",
    );
    expect(migration).toContain(
      "query_ends_at <= timestamptz '2200-01-01 00:00:00+00'",
    );
    expect(migration).toContain(
      "query_ends_at - query_starts_at <= interval '3660 days'",
    );
    expect(migration).toContain("marking.starts_at < guard.ends_at");
    expect(migration).toContain("marking.ends_at > guard.starts_at");
  });

  it("makes omitted timing neutral and keeps ordinary unavailable declarations", () => {
    expect(migration).toContain("THEN 'TIMING_NOT_SUPPLIED'");
    expect(migration).toContain("ELSE 'UNAVAILABLE_OVERLAP'");
    expect(migration).toContain("WHERE NOT classified.filter_available");
    expect(migration).not.toMatch(
      /WHERE[^;]*match_kind\s*<>\s*'UNAVAILABLE_OVERLAP'/iu,
    );
  });

  it("fails closed on MIXED and filters only AVAILABLE-only overlap", () => {
    expect(migration).toContain("THEN 'MIXED_OVERLAP'");
    expect(migration).toContain(
      "OR classified.match_kind = 'AVAILABLE_OVERLAP'",
    );
    expect(migration).toContain(
      "classified.match_kind = 'AVAILABLE_OVERLAP' AS indicatively_available",
    );
    expect(migration).not.toMatch(
      /OR classified\.match_kind = 'MIXED_OVERLAP'/u,
    );
  });

  it("returns no exact private periods, capacity, booking or contact data", () => {
    expect(CRAFTSMAN_AVAILABILITY_MATCH_RESULT_COLUMNS).toEqual([
      "craftsman_profile_id",
      "match_kind",
      "indicatively_available",
    ]);
    const returns = migration.match(
      /RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/u,
    )?.[1];
    expect(returns).toBeDefined();
    expect(returns).not.toMatch(
      /starts_at|ends_at|owner|email|phone|address|contact|count|capacity|booking|source|employer/iu,
    );
    expect(migration).toContain("full-interval coverage");
    expect(migration).toContain("never exposed");
  });
});
