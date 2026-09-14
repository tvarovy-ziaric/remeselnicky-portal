import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  CRAFTSMAN_AVAILABILITY_COMMAND_KINDS,
  CRAFTSMAN_AVAILABILITY_COMMAND_RESULTS,
  craftsmanAvailabilityCommands,
  craftsmanAvailabilityRevisions,
} from "../src/index.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0021_craftsman_availability.sql", import.meta.url),
  ),
  "utf8",
);

describe("lightweight craftsman availability schema", () => {
  it("models explicit ADD, REPLACE and ARCHIVE command history", () => {
    expect(CRAFTSMAN_AVAILABILITY_COMMAND_KINDS).toEqual([
      "ADD",
      "REPLACE",
      "ARCHIVE",
    ]);
    expect(CRAFTSMAN_AVAILABILITY_COMMAND_RESULTS).toEqual([
      "APPLIED",
      "UNCHANGED",
    ]);
    expect(
      getTableConfig(craftsmanAvailabilityCommands).columns.map(
        ({ name }) => name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "command_id",
        "command_kind",
        "block_id",
        "craftsman_profile_id",
        "actor_user_id",
        "expected_revision",
        "resulting_revision",
        "availability",
        "starts_at",
        "ends_at",
        "payload_fingerprint",
      ]),
    );
    expect(
      getTableConfig(craftsmanAvailabilityRevisions).uniqueConstraints,
    ).toHaveLength(1);
    expect(migration).toContain(
      "NEW.resulting_revision := current.revision + 1",
    );
    expect(migration).toContain("NEW.revision := source.resulting_revision");
    expect(migration).toContain("NEW.changed_at := source.created_at");
  });

  it("uses bounded finite UTC instants without a narrow product duration cap", () => {
    expect(migration).toContain("starts_at timestamptz NOT NULL");
    expect(migration).toContain("ends_at timestamptz NOT NULL");
    expect(migration).toContain("isfinite(starts_at)");
    expect(migration).toContain("isfinite(ends_at)");
    expect(migration).toContain("interval '3660 days'");
    expect(migration).toContain("starts_at < ends_at");
  });

  it("allows overlaps without precedence, auto-merge or exclusion semantics", () => {
    expect(migration).not.toMatch(
      /EXCLUDE USING gist|overlap_priority|auto_merge/iu,
    );
    expect(migration).toContain("Overlaps have no automatic precedence");
  });

  it("enforces ACTIVE owner authorization and immutable exact command effects", () => {
    expect(migration).toContain("FOR UPDATE OF profile, owner");
    expect(migration).toContain("owner_state <> 'ACTIVE'");
    expect(migration).toContain(
      "availability revision must exactly match applied command provenance",
    );
    expect(migration).toContain(
      "unchanged availability command must be recorded as unchanged",
    );
    expect(migration).toContain(
      "applied availability command requires exact revision effect",
    );
    expect(migration).toContain(
      "craftsman availability history is append-only",
    );
  });

  it("keeps precise periods private and excludes scheduling-engine concepts", () => {
    const columns = [
      ...getTableConfig(craftsmanAvailabilityCommands).columns,
      ...getTableConfig(craftsmanAvailabilityRevisions).columns,
    ].map(({ name }) => name);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "booking_id",
        "capacity",
        "crew_id",
        "customer_id",
        "employer",
        "external_source",
        "note",
        "recurrence_rule",
        "calendar_sync_id",
        "contractual_guarantee",
      ]),
    );
    expect(migration).not.toMatch(/CREATE (MATERIALIZED )?VIEW public_/iu);
    expect(migration).toContain("Private owner projection only");
  });
});
