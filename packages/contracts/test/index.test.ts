import { describe, expect, it } from "vitest";

import {
  platformContract,
  type ApiResourceReference,
  type PlatformContract,
} from "../src/index.js";

describe("@portal/contracts", () => {
  it("exports a stable runtime and transport contract", () => {
    const resource: ApiResourceReference = { id: "entity-1" };
    const contract: PlatformContract = platformContract;

    expect(resource).toEqual({ id: "entity-1" });
    expect(contract.apiVersion).toBe("v1");
  });
});
