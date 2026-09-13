import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  USER_ACCOUNT_STATE_VALUES,
  users,
  type NewUserRecord,
} from "../src/index.js";

describe("User persistence schema", () => {
  it("keeps account state independent from customer/craftsman profiles", () => {
    const config = getTableConfig(users);

    expect(USER_ACCOUNT_STATE_VALUES).toEqual([
      "ACTIVE",
      "SUSPENDED",
      "DEACTIVATED",
    ]);
    expect(config.columns.map(({ name }) => name)).toEqual([
      "id",
      "account_state",
      "account_state_changed_at",
      "created_at",
      "updated_at",
    ]);
    expect(config.columns.some(({ name }) => /role|profile/i.test(name))).toBe(
      false,
    );
  });

  it("allows the database to author identity, initial state, and timestamps", () => {
    const insert: NewUserRecord = {};

    expect(insert).toEqual({});
  });
});
