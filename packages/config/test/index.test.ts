import { describe, expect, it } from "vitest";

import * as configPackage from "../src/index.js";

describe("@portal/config", () => {
  it("provides an empty-safe import boundary", () => {
    expect(Object.keys(configPackage)).toEqual([]);
  });
});
