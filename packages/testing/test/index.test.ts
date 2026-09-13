import { describe, expect, it } from "vitest";

import * as testingPackage from "../src/index.js";

describe("@portal/testing", () => {
  it("provides an empty-safe import boundary", () => {
    expect(Object.keys(testingPackage)).toEqual([]);
  });
});
