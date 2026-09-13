import { describe, expect, it } from "vitest";

import { parsePublicConfig } from "../src/public.js";

describe("public configuration", () => {
  it("returns only explicitly public deployment context", () => {
    const config = parsePublicConfig({
      DATABASE_URL: "postgresql://private.example/portal",
      PASSWORD_RESET_TTL_SECONDS: "3600",
      NEXT_PUBLIC_APP_ENV: "staging",
      NEXT_PUBLIC_RELEASE_REVISION: "release-123",
      SESSION_SECRET: "must-not-cross-the-public-boundary",
      SESSION_TTL_SECONDS: "604800",
    });

    expect(config).toEqual({
      environment: "staging",
      releaseRevision: "release-123",
    });
    expect(JSON.stringify(config)).not.toContain("private.example");
    expect(JSON.stringify(config)).not.toContain("must-not-cross");
  });

  it("rejects an implicit or invalid environment", () => {
    expect(() =>
      parsePublicConfig({ NEXT_PUBLIC_RELEASE_REVISION: "release-123" }),
    ).toThrow();
    expect(() =>
      parsePublicConfig({
        NEXT_PUBLIC_APP_ENV: "prod",
        NEXT_PUBLIC_RELEASE_REVISION: "release-123",
      }),
    ).toThrow();
  });
});
