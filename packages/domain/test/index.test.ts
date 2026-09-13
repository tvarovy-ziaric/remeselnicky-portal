import { describe, expect, it } from "vitest";

import { domainContract, type EntityId } from "../src/index.js";

describe("@portal/domain", () => {
  it("exports its framework-independent domain boundary", () => {
    const id: EntityId = "entity-1";

    expect(id).toBe("entity-1");
    expect(domainContract).toEqual({
      entityIdRepresentation: "opaque-string",
    });
  });
});
