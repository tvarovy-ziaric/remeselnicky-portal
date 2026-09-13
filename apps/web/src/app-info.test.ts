import { describe, expect, it } from "vitest";

import { appInfo } from "./app-info";

describe("web application metadata", () => {
  it("uses the shared API contract version", () => {
    expect(appInfo.apiVersion).toBe("v1");
  });
});
