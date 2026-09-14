import { describe, expect, it } from "vitest";

import { withIsolatedPostgresDatabase } from "../src/postgres.js";

describe("isolated PostgreSQL safety guard", () => {
  it.each([
    {
      baseConnectionString: "postgresql://owner@db.internal/portal_test",
      environment: "test" as const,
    },
    {
      baseConnectionString: "postgresql://owner@db.internal/portal_staging",
      environment: "staging" as const,
    },
    {
      baseConnectionString:
        "postgresql://owner@db.internal/portal_prod?sslmode=require",
      environment: "staging" as const,
    },
  ])("rejects unsafe target $baseConnectionString", async (configuration) => {
    await expect(
      withIsolatedPostgresDatabase({
        ...configuration,
        run: () => Promise.resolve(),
      }),
    ).rejects.toThrow();
  });

  it.each(["production", "preview"])(
    "rejects the %s environment value at runtime",
    async (environment) => {
      await expect(
        withIsolatedPostgresDatabase({
          baseConnectionString: "postgresql://owner@localhost/portal_test",
          environment: environment as never,
          run: () => Promise.resolve(),
        }),
      ).rejects.toThrow(/allowed only/u);
    },
  );

  it("rejects malformed and non-PostgreSQL URLs before connecting", async () => {
    await expect(
      withIsolatedPostgresDatabase({
        baseConnectionString: "https://localhost/portal_test",
        environment: "test",
        run: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/PostgreSQL/u);
  });
});
