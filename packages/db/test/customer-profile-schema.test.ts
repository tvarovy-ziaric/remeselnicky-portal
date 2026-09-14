import { readFileSync } from "node:fs";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  customerProfiles,
  type NewCustomerProfileRecord,
} from "../src/index.js";

const migration = readFileSync(
  new URL("../migrations/0014_customer_profile.sql", import.meta.url),
  "utf8",
);

describe("CustomerProfile persistence schema", () => {
  it("stores one private, non-indexable capability per owning User", () => {
    const config = getTableConfig(customerProfiles);

    expect(config.columns.map(({ name }) => name)).toEqual([
      "id",
      "owner_user_id",
      "is_public",
      "is_indexable",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.uniqueConstraints
        .find(({ name }) => name === "customer_profiles_owner_user_id_key")
        ?.columns.map(({ name }) => name),
    ).toEqual(["owner_user_id"]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "customer_profiles_never_indexable",
        "customer_profiles_never_public",
        "customer_profiles_update_not_before_creation",
      ]),
    );
  });

  it("accepts only the server-selected owner from a creation command", () => {
    const insert: NewCustomerProfileRecord = {
      ownerUserId: "00000000-0000-4000-8000-000000000211",
    };

    expect(insert).toEqual({
      ownerUserId: "00000000-0000-4000-8000-000000000211",
    });
  });

  it("guards active ownership, stable identity and history in PostgreSQL", () => {
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain(
      "customer profile owner account must be active",
    );
    expect(migration).toContain("customer_profiles_active_owner_guard");
    expect(migration).toContain("customer_profiles_identity_guard");
    expect(migration).toContain("customer_profiles_delete_guard");
    expect(migration).toContain(
      "customer profile history cannot be deleted by ordinary operation",
    );
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu);
    expect(migration).not.toMatch(/^(?:BEGIN|COMMIT);$/gimu);
  });
});
