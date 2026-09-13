import { describe, expect, it } from "vitest";

import {
  domainContract,
  isUserAccountState,
  USER_ACCOUNT_STATES,
  type EntityId,
  type User,
  type UserId,
} from "../src/index.js";

describe("@portal/domain", () => {
  it("exports its framework-independent domain boundary", () => {
    const id: EntityId = "entity-1";

    expect(id).toBe("entity-1");
    expect(domainContract).toEqual({
      entityIdRepresentation: "opaque-string",
    });
  });

  it("models one account independently from optional profile capabilities", () => {
    const user: User = {
      id: "018f4f58-e741-7b63-8742-88c9f09b2382" as UserId,
      accountState: "ACTIVE",
      accountStateChangedAt: new Date("2026-09-14T00:00:00.000Z"),
      createdAt: new Date("2026-09-14T00:00:00.000Z"),
      updatedAt: new Date("2026-09-14T00:00:00.000Z"),
    };

    expect(user.accountState).toBe("ACTIVE");
    expect(USER_ACCOUNT_STATES).toEqual(["ACTIVE", "SUSPENDED", "DEACTIVATED"]);
    expect("role" in user).toBe(false);
  });

  it("recognizes only locked account states", () => {
    expect(isUserAccountState("SUSPENDED")).toBe(true);
    expect(isUserAccountState("ADMIN")).toBe(false);
    expect(isUserAccountState(undefined)).toBe(false);
  });
});
