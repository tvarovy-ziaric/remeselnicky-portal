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
    expect(config.auth).toEqual({
      cookieName: "__Host-portal.sid",
      cookieSecure: true,
      passwordResetTtlMs: 3_600_000,
      rateLimitMax: 10,
      rateLimitWindowMs: 900_000,
      sessionTtlMs: 604_800_000,
      trustProxyHops: 1,
    });
    expect(config.secrets.databaseUrl).toBe(productionEnvironment.DATABASE_URL);
  });

  it("supports bounded auth timing overrides without exposing secrets", () => {
    const config = parseServerConfig({
      ...productionEnvironment,
      AUTH_RATE_LIMIT_MAX: "5",
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "120",
      PASSWORD_RESET_TTL_SECONDS: "900",
      SESSION_TTL_SECONDS: "86400",
    });

    expect(config.auth).toMatchObject({
      passwordResetTtlMs: 900_000,
      rateLimitMax: 5,
      rateLimitWindowMs: 120_000,
      sessionTtlMs: 86_400_000,
    });
  });

  it.each([
    ["AUTH_RATE_LIMIT_MAX", "0"],
    ["AUTH_RATE_LIMIT_WINDOW_SECONDS", "59"],
    ["PASSWORD_RESET_TTL_SECONDS", "86401"],
    ["SESSION_TTL_SECONDS", "not-a-number"],
  ])("rejects unsafe auth setting %s", (field, value) => {
    expect(() =>
      parseServerConfig({ ...productionEnvironment, [field]: value }),
    ).toThrow(ConfigurationError);
  });

  it("uses non-secure development cookies without trusting a proxy", () => {
    const config = parseServerConfig({
      ...productionEnvironment,
      APP_ENV: "development",
      APP_ORIGIN: "http://portal.localhost",
      DATABASE_URL: "postgresql://portal:password@localhost/portal",
      RELEASE_REVISION: "local-development",
      SESSION_SECRET: "development-session-secret-at-least-32-characters",
    });

    expect(config.auth).toMatchObject({
      cookieName: "portal.sid",
      cookieSecure: false,
      trustProxyHops: 0,
    });
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
