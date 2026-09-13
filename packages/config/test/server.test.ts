import packageManifest from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { ConfigurationError, parseServerConfig } from "../src/server.js";

const productionEnvironment = {
  APP_ENV: "production",
  APP_ORIGIN: "https://portal.example",
  DATABASE_URL:
    "postgresql://portal:strong-database-password@db.example/portal?sslmode=require",
  PORT: "3001",
  RELEASE_REVISION: "git-a1b2c3d4",
  SESSION_SECRET: "b0532e6824294ba2ae7689048218f71f8da9e6cc5121ab33",
} as const;

describe("server configuration", () => {
  it("parses required values and exposes observability context", () => {
    const config = parseServerConfig(productionEnvironment);

    expect(config.environment).toBe("production");
    expect(config.port).toBe(3_001);
    expect(config.observability).toEqual({
      environment: "production",
      releaseRevision: "git-a1b2c3d4",
    });
    expect(config.secrets.databaseUrl).toBe(productionEnvironment.DATABASE_URL);
  });

  it("fails production startup when a required secret is absent", () => {
    const withoutSecret: Record<string, string | undefined> = {
      ...productionEnvironment,
    };
    delete withoutSecret.SESSION_SECRET;

    expect(() => parseServerConfig(withoutSecret)).toThrow(ConfigurationError);
    expect(() => parseServerConfig(withoutSecret)).toThrow(/SESSION_SECRET/);
  });

  it.each([
    ["an HTTP origin", { APP_ORIGIN: "http://portal.example" }],
    [
      "a local database",
      {
        DATABASE_URL:
          "postgresql://portal:password@localhost/portal?sslmode=require",
      },
    ],
    [
      "a database connection without TLS",
      {
        DATABASE_URL: "postgresql://portal:password@db.example/portal",
      },
    ],
    ["a placeholder release", { RELEASE_REVISION: "unknown" }],
  ])("rejects %s in production", (_case, override) => {
    expect(() =>
      parseServerConfig({ ...productionEnvironment, ...override }),
    ).toThrow(ConfigurationError);
  });

  it("never includes secret values in validation errors", () => {
    const unsafeSecret = "visible-but-invalid";

    try {
      parseServerConfig({
        ...productionEnvironment,
        SESSION_SECRET: unsafeSecret,
      });
      expect.unreachable("invalid configuration should throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      if (error instanceof Error) {
        expect(error.message).not.toContain(unsafeSecret);
      }
    }
  });

  it("publishes the server entry point only for Node runtimes", () => {
    const serverExport = packageManifest.exports["./server"];

    expect(serverExport).toEqual({
      types: "./dist/server.d.ts",
      node: "./dist/server.js",
    });
    expect(serverExport).not.toHaveProperty("browser");
    expect(serverExport).not.toHaveProperty("default");
    expect(serverExport).not.toHaveProperty("import");
  });
});
